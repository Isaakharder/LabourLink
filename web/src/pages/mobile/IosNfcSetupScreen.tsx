import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useWorkSession } from "../../context/WorkSessionContext";
import { buildTextRecord, buildUriRecord, eraseTag, isNfcSupported, ScannedTag, startScanSession, writeNdefRecords, writeTag } from "../../lib/nfc";
import { findTagAssignment, resolveScannedTag } from "../../lib/nfcMappingCache";
import { addPendingTag, listPendingTags, PendingTagRegistration, subscribePendingTags } from "../../lib/pendingTagStore";
import { flushPendingTagRegistrations, resolvePendingTagConflict } from "../../lib/pendingTagSync";
import { fetchCarriersWithCache, fetchRowsWithCache, fetchTagActivityTargetsWithCache } from "../../lib/referenceDataCache";
import {
  ACTION_LABELS,
  AssignMode,
  planAssign,
  planClear,
  planCustomWrite,
  rowTargetLabel,
  TagWriteTarget,
  validateCustomContent,
} from "../../lib/tagWritePlan";
import { uuid } from "../../lib/uuid";
import { RowPickerLand, RowPickerSheet } from "../../components/mobile/RowPickerSheet";
import { CarrierPickerSheet, PickerCarrier } from "../../components/mobile/CarrierPickerSheet";

// The eight Set Up NFC Tag choices (Settings → Set Up NFC Tag sheet).
export const NFC_SETUP_KINDS = ["activities", "rows", "bins", "start-break", "end-break", "end-work", "clear", "custom"] as const;
export type NfcSetupKind = (typeof NFC_SETUP_KINDS)[number];
export const NFC_SETUP_LABELS: Record<NfcSetupKind, string> = {
  activities: "Activities",
  rows: "Rows",
  bins: "Bins",
  "start-break": "Start Break",
  "end-break": "End Break",
  "end-work": "End Work",
  clear: "Clear Tag",
  custom: "Custom Text / URL",
};
const ACTION_FOR_KIND: Partial<Record<NfcSetupKind, keyof typeof ACTION_LABELS>> = {
  "start-break": "start_break",
  "end-break": "end_break",
  "end-work": "end_work",
};

type Step = "choose-target" | "options" | "scanning" | "result";
type ResultLine = { tone: "ok" | "warn" | "error"; text: string };
type Result = { title: string; lines: ResultLine[]; conflictEntryId?: string };

function registrationLines(entry: PendingTagRegistration | undefined, label: string, online: boolean): { title: string; lines: ResultLine[]; conflictEntryId?: string } {
  if (!entry) return { title: "Tag assigned", lines: [{ tone: "ok", text: `The tag is assigned to ${label} and registered.` }] };
  if (entry.status === "conflict") {
    return {
      title: "Tag set up — not registered yet",
      lines: [{ tone: "warn", text: `${label} already has a different tag registered. Choose below whether to replace it.` }],
      conflictEntryId: entry.id,
    };
  }
  if (entry.status === "failed") return { title: "Registration refused", lines: [{ tone: "error", text: entry.lastError ?? "The server refused this assignment." }] };
  return {
    title: "Tag set up — awaiting sync",
    lines: [
      {
        tone: "ok",
        text: `The tag works as ${label} on this phone now. It will be registered ${online ? "as soon as the server can be reached" : "when the phone reconnects"}; other phones learn it after that.`,
      },
    ],
  };
}

// iPhone-only. One place to set up, rewrite or clear tags, online or offline.
export function IosNfcSetupScreen() {
  const { kind: rawKind } = useParams();
  const kind = (NFC_SETUP_KINDS as readonly string[]).includes(rawKind ?? "") ? (rawKind as NfcSetupKind) : null;
  const { me, online } = useWorkSession();
  const isAdmin = me?.employee.securityRole === "Administrator" || me?.employee.securityRole === "Manager";
  const action = kind ? ACTION_FOR_KIND[kind] : undefined;
  const needsTarget = kind === "activities" || kind === "rows" || kind === "bins";

  const [step, setStep] = useState<Step>(needsTarget ? "choose-target" : "options");
  const [target, setTarget] = useState<TagWriteTarget | null>(
    action ? { targetType: "action", targetId: action, label: ACTION_LABELS[action] } : null
  );
  const [mode, setMode] = useState<AssignMode>("as-is");
  const [overwriteConfirmed, setOverwriteConfirmed] = useState(false);
  const [eraseRequested, setEraseRequested] = useState(false);
  const [customKind, setCustomKind] = useState<"text" | "url">("text");
  const [customValue, setCustomValue] = useState("");
  const [rowLands, setRowLands] = useState<RowPickerLand[] | null>(null);
  const [carriers, setCarriers] = useState<PickerCarrier[] | null>(null);
  const [activities, setActivities] = useState<{ id: string; name: string }[] | null>(null);
  const [nfcAvailable, setNfcAvailable] = useState<boolean | null>(null);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [pending, setPending] = useState<PendingTagRegistration[]>(() => listPendingTags());
  const [busyEntry, setBusyEntry] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => subscribePendingTags(() => setPending(listPendingTags())), []);
  useEffect(() => {
    if (kind === "rows") fetchRowsWithCache().then((r) => setRowLands(r.data.lands)).catch(() => setRowLands([]));
    if (kind === "bins") fetchCarriersWithCache().then((r) => setCarriers(r.data.carriers)).catch(() => setCarriers([]));
    if (kind === "activities") fetchTagActivityTargetsWithCache().then((r) => setActivities(r.data.activities)).catch(() => setActivities([]));
    isNfcSupported().then(setNfcAvailable);
    void flushPendingTagRegistrations();
    return () => stopRef.current?.();
  }, [kind]);
  useEffect(() => {
    if (online) void flushPendingTagRegistrations();
  }, [online]);

  const queueAndSync = useCallback(
    async (entry: Omit<PendingTagRegistration, "id" | "writtenAt" | "status" | "attempts" | "lastError" | "conflict" | "confirmReplaceTarget">) => {
      const id = uuid();
      addPendingTag({ ...entry, id, writtenAt: new Date().toISOString(), status: "pending", attempts: 0, lastError: null, conflict: null, confirmReplaceTarget: false });
      if (navigator.onLine) await flushPendingTagRegistrations();
      return listPendingTags().find((e) => e.id === id);
    },
    []
  );

  function finish(r: Result) {
    setResult(r);
    setStep("result");
  }

  async function handleTag(tag: ScannedTag, stop: () => void) {
    if (kind === "clear") {
      const plan = planClear(tag, findTagAssignment(tag), eraseRequested);
      const lines: ResultLine[] = [];
      if (plan.erase === "erase") {
        const r = await eraseTag({ isWritable: tag.isWritable }, { iosSuccessMessage: "Tag cleared" });
        lines.push(
          r.ok && r.verified
            ? { tone: "ok", text: "Erased the tag's contents." }
            : { tone: "error", text: `Not erased: ${r.ok ? "the erase couldn't be verified. Keep the tag still and try again." : r.message}` }
        );
      } else if (plan.erase === "read-only") {
        lines.push({ tone: "warn", text: "Not erased: this tag is read-only, so its contents can't be erased." });
      }
      stop();
      if (plan.unassign) {
        const entry = await queueAndSync({
          op: "unassign",
          targetType: plan.unassign.target.targetType,
          targetId: plan.unassign.target.targetId,
          label: plan.unassign.target.label,
          labourlinkTagUuid: plan.unassign.labourlinkTagUuid,
          ridderHardwareId: plan.unassign.ridderHardwareId,
        });
        lines.unshift(
          !entry
            ? { tone: "ok", text: `Removed its assignment to ${plan.unassign.target.label}.` }
            : entry.status === "failed"
              ? { tone: "error", text: `Assignment not removed: ${entry.lastError}` }
              : { tone: "ok", text: `Removed its assignment to ${plan.unassign.target.label} on this phone. The server removal will sync when the phone reconnects.` }
        );
      } else {
        lines.unshift({ tone: "warn", text: "This tag had no LabourLink assignment." });
      }
      if (plan.erase === "not-requested") lines.push({ tone: "ok", text: "The tag's contents were left unchanged." });
      finish({ title: "Clear Tag", lines });
      return;
    }

    if (kind === "custom") {
      const plan = planCustomWrite(tag, resolveScannedTag(tag));
      if (plan.kind !== "write") {
        stop();
        finish({
          title: "Tag not written",
          lines: [
            plan.kind === "assigned"
              ? { tone: "error", text: `This tag is assigned to ${plan.label}. Clear it first — an active LabourLink tag is never overwritten.` }
              : { tone: "error", text: "This tag is read-only and can't be written." },
          ],
        });
        return;
      }
      const record = customKind === "url" ? buildUriRecord(customValue.trim()) : buildTextRecord(customValue.trim());
      const r = await writeNdefRecords([record], { isWritable: tag.isWritable, maxSize: tag.maxSize }, { iosSuccessMessage: "Tag written" });
      stop();
      finish(
        r.ok && r.verified
          ? { title: customKind === "url" ? "URL written" : "Text written", lines: [{ tone: "ok", text: "Written and verified. LabourLink doesn't act on this tag when it's scanned." }] }
          : { title: "Write failed", lines: [{ tone: "error", text: r.ok ? "The write couldn't be verified. Keep the tag still and try again." : r.message }, { tone: "warn", text: "Nothing was saved." }] }
      );
      return;
    }

    // Activities, rows, bins and the three actions.
    if (!target) return stop();
    const plan = planAssign(tag, target, resolveScannedTag(tag), mode);
    switch (plan.kind) {
      case "already-this-target":
        stop();
        return finish({ title: "Already set up", lines: [{ tone: "ok", text: `This tag is already assigned to ${plan.label}. Nothing was changed.` }] });
      case "assigned-elsewhere":
        stop();
        return finish({ title: "Tag not changed", lines: [{ tone: "error", text: `This tag is assigned to ${plan.label}. Use Clear Tag first if it should become ${target.label}.` }] });
      case "read-only":
        stop();
        return finish({ title: "Tag not written", lines: [{ tone: "error", text: "This tag is read-only. Choose \"Use the tag as it is\" to assign it without writing." }] });
      case "no-identifier":
        stop();
        return finish({ title: "Tag not assigned", lines: [{ tone: "error", text: "This tag doesn't expose an ID the iPhone can read. Write a new LabourLink tag to it instead." }] });
      case "register-uuid":
      case "register-hardware": {
        stop();
        const entry = await queueAndSync({
          op: "assign",
          targetType: target.targetType,
          targetId: target.targetId,
          label: target.label,
          labourlinkTagUuid: plan.kind === "register-uuid" ? plan.labourlinkTagUuid : null,
          ridderHardwareId: plan.kind === "register-hardware" ? plan.ridderHardwareId : null,
        });
        return finish(registrationLines(entry, target.label, navigator.onLine));
      }
      case "write": {
        const newTagId = uuid();
        const r = await writeTag(newTagId, { isWritable: tag.isWritable, maxSize: tag.maxSize }, { iosSuccessMessage: "Tag written" });
        stop();
        if (!r.ok || !r.verified) {
          return finish({
            title: "Write failed",
            lines: [
              { tone: "error", text: r.ok ? "The write couldn't be verified. Keep the tag still and write it again." : r.message },
              { tone: "warn", text: "Nothing was saved. The tag was not assigned." },
            ],
          });
        }
        const entry = await queueAndSync({
          op: "assign",
          targetType: target.targetType,
          targetId: target.targetId,
          label: target.label,
          labourlinkTagUuid: newTagId,
          ridderHardwareId: null,
        });
        return finish(registrationLines(entry, target.label, navigator.onLine));
      }
    }
  }

  function startScan() {
    setScanMessage(null);
    setStep("scanning");
    let handled = false;
    const prompt =
      kind === "clear" ? "Hold your iPhone near the tag to clear." : kind === "custom" ? "Hold your iPhone near the tag to write." : `Hold your iPhone near the tag for ${target?.label ?? "this"}.`;
    const stop = startScanSession(
      (tag) => {
        if (handled) return;
        handled = true;
        void handleTag(tag, stop);
      },
      (message) => {
        if (handled) return;
        handled = true;
        setScanMessage(message);
        setStep("options");
      },
      "IosNfcSetupScreen",
      prompt,
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
    if (result?.conflictEntryId === entry.id) {
      if (choice === "keep") finish({ title: "Kept the existing tag", lines: [{ tone: "ok", text: "This phone's new assignment was discarded." }] });
      else finish(registrationLines(listPendingTags().find((e) => e.id === entry.id), entry.label, navigator.onLine));
    }
  }

  function again() {
    setResult(null);
    setScanMessage(null);
    setOverwriteConfirmed(false);
    if (needsTarget) {
      setTarget(null);
      setStep("choose-target");
    } else setStep("options");
  }

  if (!isAdmin) {
    return (
      <div className="mobile-settings">
        <h1>Set Up NFC Tag</h1>
        <p className="error-text">This screen requires an Administrator or Manager role.</p>
        <Link to="/mobile/settings" className="mobile-action-button mobile-action-secondary">
          Back to Settings
        </Link>
      </div>
    );
  }
  if (!kind) {
    return (
      <div className="mobile-settings">
        <h1>Set Up NFC Tag</h1>
        <p className="error-text">Unknown tag type.</p>
        <Link to="/mobile/settings" className="mobile-action-button mobile-action-secondary">
          Back to Settings
        </Link>
      </div>
    );
  }

  const customError = kind === "custom" ? validateCustomContent(customKind, customValue) : null;
  const assignKind = kind !== "clear" && kind !== "custom";
  const canScan =
    nfcAvailable !== false &&
    (assignKind ? Boolean(target) && (mode === "as-is" || overwriteConfirmed) : kind === "clear" ? true : !customError && overwriteConfirmed);

  return (
    <div className="mobile-settings">
      <h1>{NFC_SETUP_LABELS[kind]}</h1>
      <Link to="/mobile/settings" className="mobile-action-button mobile-action-secondary">
        Back to Settings
      </Link>
      {!online && <p className="mobile-settings-device-note">Offline — changes take effect on this phone now and sync when it reconnects.</p>}

      {step === "choose-target" && kind === "rows" && (
        <RowPickerSheet
          directRowList
          activityName=""
          questionLabel="Select the row"
          allowSkip={false}
          lands={rowLands}
          error={null}
          busy={false}
          onConfirm={(rowId) => {
            setTarget({ targetType: "greenhouse_row", targetId: rowId, label: rowTargetLabel(rowLands, rowId) });
            setStep("options");
          }}
          onSkip={() => {}}
          onCancel={() => window.history.back()}
          language="en"
        />
      )}
      {step === "choose-target" && kind === "bins" && (
        <CarrierPickerSheet
          activityName=""
          questionLabel="Select the bin"
          allowSkip={false}
          carriers={carriers}
          error={null}
          busy={false}
          onConfirm={(carrierId) => {
            setTarget({ targetType: "carrier", targetId: carrierId, label: carriers?.find((c) => c.id === carrierId)?.name ?? "Selected bin" });
            setStep("options");
          }}
          onSkip={() => {}}
          onCancel={() => window.history.back()}
          language="en"
        />
      )}
      {step === "choose-target" && kind === "activities" && (
        <section className="mobile-settings-device-section">
          <h2>Choose the activity</h2>
          {!activities ? (
            <p className="mobile-settings-device-note">Loading…</p>
          ) : activities.length === 0 ? (
            <p className="error-text">No activities are saved on this phone yet. Connect once to download them.</p>
          ) : (
            <div className="mobile-choice-grid">
              {activities.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className="mobile-choice-button"
                  onClick={() => {
                    setTarget({ targetType: "activity", targetId: a.id, label: a.name });
                    setStep("options");
                  }}
                >
                  {a.name}
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {(step === "options" || step === "scanning") && (
        <section className="mobile-settings-device-section">
          {assignKind && target && (
            <>
              <h2>Set up a tag for {target.label}</h2>
              <div className="mobile-radio-list" role="radiogroup" aria-label="How to set up the tag">
                <label>
                  <input type="radio" name="mode" checked={mode === "as-is"} onChange={() => setMode("as-is")} disabled={step === "scanning"} />
                  Use the tag as it is — keeps its contents (works with read-only tags)
                </label>
                <label>
                  <input type="radio" name="mode" checked={mode === "write"} onChange={() => setMode("write")} disabled={step === "scanning"} />
                  Write a new LabourLink tag — replaces anything on the tag
                </label>
              </div>
              {mode === "write" && (
                <label className="mobile-check">
                  <input type="checkbox" checked={overwriteConfirmed} onChange={(e) => setOverwriteConfirmed(e.target.checked)} disabled={step === "scanning"} />
                  I understand anything already on this tag will be replaced.
                </label>
              )}
            </>
          )}
          {kind === "clear" && (
            <>
              <h2>Clear a tag</h2>
              <p className="mobile-settings-device-note">Scanning removes the tag's LabourLink assignment, if it has one.</p>
              <label className="mobile-check">
                <input type="checkbox" checked={eraseRequested} onChange={(e) => setEraseRequested(e.target.checked)} disabled={step === "scanning"} />
                Also erase the tag's contents (writable tags only)
              </label>
            </>
          )}
          {kind === "custom" && (
            <>
              <h2>Write custom content</h2>
              <div className="mobile-radio-list" role="radiogroup" aria-label="Content type">
                <label>
                  <input type="radio" name="custom-kind" checked={customKind === "text"} onChange={() => setCustomKind("text")} disabled={step === "scanning"} />
                  Text
                </label>
                <label>
                  <input type="radio" name="custom-kind" checked={customKind === "url"} onChange={() => setCustomKind("url")} disabled={step === "scanning"} />
                  URL
                </label>
              </div>
              <input
                className="mobile-text-input"
                aria-label={customKind === "url" ? "URL" : "Text"}
                placeholder={customKind === "url" ? "https://…" : "Text to write"}
                value={customValue}
                onChange={(e) => setCustomValue(e.target.value)}
                disabled={step === "scanning"}
              />
              {customValue && customError && <p className="error-text">{customError}</p>}
              <p className="mobile-settings-device-note">LabourLink never acts on custom tags or opens their links when they're scanned at work.</p>
              <label className="mobile-check">
                <input type="checkbox" checked={overwriteConfirmed} onChange={(e) => setOverwriteConfirmed(e.target.checked)} disabled={step === "scanning"} />
                I understand anything already on this tag will be replaced.
              </label>
            </>
          )}
          {nfcAvailable === false && <p className="error-text">This phone does not have NFC available.</p>}
          {scanMessage && <p className="error-text">{scanMessage}</p>}
          <div className="mobile-confirm-actions">
            <button type="button" className="mobile-action-button mobile-action-primary" disabled={!canScan || step === "scanning"} onClick={startScan}>
              {step === "scanning" ? "Hold the tag near the iPhone…" : "Scan tag"}
            </button>
            {needsTarget && (
              <button type="button" className="mobile-action-button" disabled={step === "scanning"} onClick={again}>
                Choose a different {kind === "rows" ? "row" : kind === "bins" ? "bin" : "activity"}
              </button>
            )}
          </div>
        </section>
      )}

      {step === "result" && result && (
        <section className="mobile-settings-device-section" aria-live="polite">
          <h2>{result.title}</h2>
          {result.lines.map((l, i) => (
            <p key={i} className={l.tone === "error" ? "error-text" : "mobile-settings-device-note"} data-tone={l.tone}>
              {l.text}
            </p>
          ))}
          <div className="mobile-confirm-actions">
            <button type="button" className="mobile-action-button mobile-action-primary" onClick={again}>
              Set up another tag
            </button>
          </div>
        </section>
      )}

      {pending.length > 0 && (
        <section className="mobile-settings-device-section" aria-label="Waiting to sync on this phone">
          <h2>Waiting to sync on this phone</h2>
          <ul className="mobile-pending-tags">
            {pending.map((e) => (
              <li key={e.id} data-status={e.status}>
                <strong>{e.op === "unassign" ? `Remove tag from ${e.label}` : e.label}</strong>
                {e.status === "pending" && <p className="mobile-settings-device-note">Awaiting sync</p>}
                {e.status === "conflict" && (
                  <>
                    <p className="error-text">
                      Not registered: {e.conflict?.label ?? e.label} already has a different tag
                      {e.conflict?.ridderHardwareId ? ` (${e.conflict.ridderHardwareId})` : ""}. Replace it with this tag, or keep the existing one?
                    </p>
                    <div className="mobile-confirm-actions">
                      <button type="button" className="mobile-action-button mobile-action-primary" disabled={busyEntry === e.id || !online} onClick={() => decide(e, "replace")}>
                        Replace with this tag
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
                    <p className="error-text">Not synced: {e.lastError}</p>
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
