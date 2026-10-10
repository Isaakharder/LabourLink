import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useWorkSession } from "../../context/WorkSessionContext";
import { isNfcSupported, startScanSession, writeTag } from "../../lib/nfc";
import { resolveScannedTag } from "../../lib/nfcMappingCache";
import { addPendingTag, listPendingTags, PendingTagRegistration, subscribePendingTags } from "../../lib/pendingTagStore";
import { flushPendingTagRegistrations, resolvePendingTagConflict } from "../../lib/pendingTagSync";
import { fetchCarriersWithCache, fetchRowsWithCache } from "../../lib/referenceDataCache";
import { checkTagBeforeWrite, rowTargetLabel, TagWriteTarget } from "../../lib/tagWritePlan";
import { uuid } from "../../lib/uuid";
import { RowPickerLand, RowPickerSheet } from "../../components/mobile/RowPickerSheet";
import { CarrierPickerSheet, PickerCarrier } from "../../components/mobile/CarrierPickerSheet";

type Step = "choose-type" | "choose-target" | "ready" | "scanning" | "result";

type Result =
  | { kind: "registered"; label: string }
  | { kind: "awaiting-sync"; label: string }
  | { kind: "conflict"; entryId: string }
  | { kind: "registration-failed"; label: string; message: string }
  | { kind: "write-failed"; message: string }
  | { kind: "not-written"; message: string };

// iPhone-only Write New Tag (WriteNewTagScreen picks this on iOS; Android
// keeps the original screen). Works without a connection:
//   - rows/bins come from the offline reference cache;
//   - ONE NFC session reads the tag, checks it, writes a new LabourLink tag
//     ID, reads it back to verify (patched plugin), then closes;
//   - a verified write is saved on this phone immediately (it scans and
//     switches offline right away) and queued for registration, which is
//     sent now if online or after reconnecting (lib/pendingTagSync.ts);
//   - a registration conflict is never resolved silently — the admin
//     chooses "Replace" or "Keep existing" in the list below.
export function IosWriteNewTagScreen() {
  const { me, online } = useWorkSession();
  const isAdmin = me?.employee.securityRole === "Administrator" || me?.employee.securityRole === "Manager";

  const [step, setStep] = useState<Step>("choose-type");
  const [targetType, setTargetType] = useState<TagWriteTarget["targetType"] | null>(null);
  const [target, setTarget] = useState<TagWriteTarget | null>(null);
  const [rowLands, setRowLands] = useState<RowPickerLand[] | null>(null);
  const [carriers, setCarriers] = useState<PickerCarrier[] | null>(null);
  const [listsFromCache, setListsFromCache] = useState(false);
  const [listsUnavailable, setListsUnavailable] = useState(false);
  const [nfcAvailable, setNfcAvailable] = useState<boolean | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingTagRegistration[]>(() => listPendingTags());
  const [busyEntry, setBusyEntry] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => subscribePendingTags(() => setPending(listPendingTags())), []);

  useEffect(() => {
    fetchRowsWithCache()
      .then((r) => {
        setRowLands(r.data.lands);
        if (r.fromCache) setListsFromCache(true);
      })
      .catch(() => setListsUnavailable(true));
    fetchCarriersWithCache()
      .then((r) => {
        setCarriers(r.data.carriers);
        if (r.fromCache) setListsFromCache(true);
      })
      .catch(() => setListsUnavailable(true));
    isNfcSupported().then(setNfcAvailable);
    void flushPendingTagRegistrations();
    return () => stopRef.current?.();
  }, []);

  // Reconnecting while this screen is open sends anything waiting.
  useEffect(() => {
    if (online) void flushPendingTagRegistrations();
  }, [online]);

  const finishWithRegistration = useCallback(async (entryId: string, label: string) => {
    if (navigator.onLine) await flushPendingTagRegistrations();
    const entry = listPendingTags().find((e) => e.id === entryId);
    if (!entry) setResult({ kind: "registered", label });
    else if (entry.status === "conflict") setResult({ kind: "conflict", entryId });
    else if (entry.status === "failed") setResult({ kind: "registration-failed", label, message: entry.lastError ?? "Registration was refused." });
    else setResult({ kind: "awaiting-sync", label });
    setStep("result");
  }, []);

  function startWrite() {
    if (!target) return;
    setScanMessage(null);
    setStep("scanning");
    let handled = false;
    const stop = startScanSession(
      async (tag) => {
        if (handled) return;
        handled = true;
        const check = checkTagBeforeWrite(tag, target, resolveScannedTag(tag));
        if (check.kind !== "write") {
          stop();
          setResult({
            kind: "not-written",
            message:
              check.kind === "read-only"
                ? "This tag is read-only and can't be written. Use a different tag."
                : check.kind === "already-this-target"
                  ? `This tag is already assigned to ${check.label}. Nothing was changed.`
                  : `This tag is already assigned to ${check.label}. It was not changed — use a blank tag for ${target.label}.`,
          });
          setStep("result");
          return;
        }
        const newTagId = uuid();
        const written = await writeTag(newTagId, { isWritable: tag.isWritable, maxSize: tag.maxSize }, { iosSuccessMessage: "Tag written" });
        stop();
        if (!written.ok || !written.verified) {
          setResult({
            kind: "write-failed",
            message: written.ok
              ? "The write could not be verified. Keep the tag still and write it again."
              : written.message,
          });
          setStep("result");
          return;
        }
        const entryId = uuid();
        addPendingTag({
          id: entryId,
          targetType: target.targetType,
          targetId: target.targetId,
          label: target.label,
          labourlinkTagUuid: newTagId,
          writtenAt: new Date().toISOString(),
          status: "pending",
          attempts: 0,
          lastError: null,
          conflict: null,
          confirmReplaceTarget: false,
        });
        await finishWithRegistration(entryId, target.label);
      },
      (message) => {
        if (handled) return;
        handled = true;
        setScanMessage(message);
        setStep("ready");
      },
      "IosWriteNewTagScreen",
      `Hold your iPhone near the tag for ${target.label}.`,
      { keepOpen: true }
    );
    stopRef.current = stop;
  }

  async function decide(entry: PendingTagRegistration, choice: "replace" | "keep") {
    setBusyEntry(entry.id);
    try {
      await resolvePendingTagConflict(entry.id, choice);
    } finally {
      setBusyEntry(null);
    }
    if (result?.kind === "conflict" && result.entryId === entry.id) {
      if (choice === "keep") reset();
      else await finishWithRegistration(entry.id, entry.label);
    }
  }

  function reset() {
    setStep("choose-type");
    setTargetType(null);
    setTarget(null);
    setResult(null);
    setScanMessage(null);
  }

  if (!isAdmin) {
    return (
      <div className="mobile-settings">
        <h1>Write New Tag</h1>
        <p className="error-text">This screen requires an Administrator or Manager role.</p>
        <Link to="/mobile/settings" className="mobile-action-button mobile-action-secondary">
          Back to Settings
        </Link>
      </div>
    );
  }

  const conflictEntry = result?.kind === "conflict" ? pending.find((e) => e.id === result.entryId) : undefined;

  return (
    <div className="mobile-settings">
      <h1>Write New Tag</h1>
      <Link to="/mobile/settings" className="mobile-action-button mobile-action-secondary">
        Back to Settings
      </Link>
      {!online && (
        <p className="mobile-settings-device-note">
          Offline — tags you write are saved on this phone and registered when it reconnects.
        </p>
      )}

      {step === "choose-type" && (
        <section className="mobile-settings-device-section">
          <h2>What does this tag go on?</h2>
          {listsUnavailable && !rowLands && !carriers && (
            <p className="error-text">Rows and bins aren't saved on this phone yet. Connect once to download them.</p>
          )}
          <div className="mobile-confirm-actions">
            <button type="button" className="mobile-action-button mobile-action-primary" onClick={() => { setTargetType("greenhouse_row"); setStep("choose-target"); }}>
              Row
            </button>
            <button type="button" className="mobile-action-button mobile-action-primary" onClick={() => { setTargetType("carrier"); setStep("choose-target"); }}>
              Bin
            </button>
          </div>
        </section>
      )}

      {step === "choose-target" && targetType === "greenhouse_row" && (
        <RowPickerSheet
          directRowList
          activityName={listsFromCache ? "Saved on this phone" : ""}
          questionLabel="Select the row"
          allowSkip={false}
          lands={rowLands}
          error={null}
          busy={false}
          onConfirm={(rowId) => {
            setTarget({ targetType: "greenhouse_row", targetId: rowId, label: rowTargetLabel(rowLands, rowId) });
            setStep("ready");
          }}
          onSkip={() => {}}
          onCancel={() => setStep("choose-type")}
          language="en"
        />
      )}
      {step === "choose-target" && targetType === "carrier" && (
        <CarrierPickerSheet
          activityName={listsFromCache ? "Saved on this phone" : ""}
          questionLabel="Select the bin"
          allowSkip={false}
          carriers={carriers}
          error={null}
          busy={false}
          onConfirm={(carrierId) => {
            setTarget({ targetType: "carrier", targetId: carrierId, label: carriers?.find((c) => c.id === carrierId)?.name ?? "Selected bin" });
            setStep("ready");
          }}
          onSkip={() => {}}
          onCancel={() => setStep("choose-type")}
          language="en"
        />
      )}

      {(step === "ready" || step === "scanning") && target && (
        <section className="mobile-settings-device-section">
          <h2>Write a tag for {target.label}</h2>
          <p className="mobile-settings-device-note">
            Anything already on the tag will be replaced. Hold the tag still against the top of the iPhone until it says
            "Tag written".
          </p>
          {nfcAvailable === false && <p className="error-text">This phone does not have NFC available.</p>}
          {scanMessage && <p className="error-text">{scanMessage}</p>}
          <div className="mobile-confirm-actions">
            <button
              type="button"
              className="mobile-action-button mobile-action-primary"
              disabled={step === "scanning" || nfcAvailable === false}
              onClick={startWrite}
            >
              {step === "scanning" ? "Hold the tag near the iPhone…" : "Scan and write tag"}
            </button>
            <button type="button" className="mobile-action-button" disabled={step === "scanning"} onClick={reset}>
              Choose a different row or bin
            </button>
          </div>
        </section>
      )}

      {step === "result" && result && (
        <section className="mobile-settings-device-section" data-result={result.kind}>
          {result.kind === "registered" && (
            <>
              <h2>Tag written and registered</h2>
              <p className="mobile-settings-device-note">The tag is now assigned to {result.label}.</p>
            </>
          )}
          {result.kind === "awaiting-sync" && (
            <>
              <h2>Tag written — awaiting sync</h2>
              <p className="mobile-settings-device-note">
                The tag is assigned to {result.label} on this phone and works for scanning now. It will be registered when the
                phone reconnects; other phones learn it after that.
              </p>
            </>
          )}
          {result.kind === "conflict" && (
            <>
              <h2>Tag written — not registered yet</h2>
              <p className="mobile-settings-device-note">
                {conflictEntry?.label ?? "This row or bin"} already has a different tag registered. Choose below in "Tags
                written on this phone".
              </p>
            </>
          )}
          {result.kind === "registration-failed" && (
            <>
              <h2>Tag written — registration refused</h2>
              <p className="error-text">{result.message}</p>
            </>
          )}
          {result.kind === "write-failed" && (
            <>
              <h2>Write failed</h2>
              <p className="error-text">{result.message}</p>
              <p className="mobile-settings-device-note">Nothing was saved. The tag was not assigned.</p>
            </>
          )}
          {result.kind === "not-written" && (
            <>
              <h2>Tag not written</h2>
              <p className="error-text">{result.message}</p>
            </>
          )}
          <div className="mobile-confirm-actions">
            {(result.kind === "write-failed" || result.kind === "not-written") && target && (
              <button type="button" className="mobile-action-button mobile-action-primary" onClick={() => { setResult(null); setStep("ready"); }}>
                Try again
              </button>
            )}
            <button type="button" className="mobile-action-button" onClick={reset}>
              Write another tag
            </button>
          </div>
        </section>
      )}

      {pending.length > 0 && (
        <section className="mobile-settings-device-section" aria-label="Tags written on this phone">
          <h2>Tags written on this phone</h2>
          <ul className="mobile-pending-tags">
            {pending.map((e) => (
              <li key={e.id} data-status={e.status}>
                <strong>{e.label}</strong>
                {e.status === "pending" && <p className="mobile-settings-device-note">Written — awaiting sync</p>}
                {e.status === "conflict" && (
                  <>
                    <p className="error-text">
                      Not registered: {e.label} already has a different tag
                      {e.conflict?.ridderHardwareId ? ` (Ridder ${e.conflict.ridderHardwareId})` : ""}. Replace it with this new tag,
                      or keep the existing one?
                    </p>
                    <div className="mobile-confirm-actions">
                      <button type="button" className="mobile-action-button mobile-action-primary" disabled={busyEntry === e.id || !online} onClick={() => decide(e, "replace")}>
                        Replace with new tag
                      </button>
                      <button type="button" className="mobile-action-button" disabled={busyEntry === e.id} onClick={() => decide(e, "keep")}>
                        Keep existing tag
                      </button>
                    </div>
                    {!online && <p className="mobile-settings-device-note">Replacing needs a connection.</p>}
                  </>
                )}
                {e.status === "failed" && (
                  <>
                    <p className="error-text">Not registered: {e.lastError}</p>
                    <button type="button" className="mobile-action-button" onClick={() => decide(e, "keep")}>
                      Remove from this phone
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
