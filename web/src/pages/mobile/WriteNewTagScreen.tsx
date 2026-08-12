import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useWorkSession } from "../../context/WorkSessionContext";
import { api, ApiError } from "../../lib/api";
import { isNfcSupported, ScannedTag, startScanSession, writeTag } from "../../lib/nfc";
import { TagMapping } from "../../lib/nfcTagTypes";
import { uuid } from "../../lib/uuid";
import { RowPickerSheet, RowPickerLand } from "../../components/mobile/RowPickerSheet";
import { CarrierPickerSheet, PickerCarrier } from "../../components/mobile/CarrierPickerSheet";

type TargetType = "greenhouse_row" | "carrier";
type Step =
  | "choose-type"
  | "choose-target"
  | "scan-blank"
  | "confirm-overwrite"
  | "writing"
  | "verify"
  | "conflict"
  | "done";

// Admin-only (server-enforced via requireDeviceAdmin) — writes a fresh,
// permanent LabourLink tag UUID to a blank or admin-confirmed tag, verifies
// it by reading it back, then saves the mapping. Never locks the tag
// (makeReadOnly is never called anywhere in lib/nfc.ts). Plain English, no
// i18n — same convention as the rest of Settings.
export function WriteNewTagScreen() {
  const { me } = useWorkSession();
  const isAdmin = me?.employee.securityRole === "Administrator" || me?.employee.securityRole === "Manager";

  const [step, setStep] = useState<Step>("choose-type");
  const [targetType, setTargetType] = useState<TargetType | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [targetLabel, setTargetLabel] = useState<string | null>(null);
  const [rowLands, setRowLands] = useState<RowPickerLand[] | null>(null);
  const [carriers, setCarriers] = useState<PickerCarrier[] | null>(null);
  const [nfcAvailable, setNfcAvailable] = useState<boolean | null>(null);
  const [detectedTag, setDetectedTag] = useState<ScannedTag | null>(null);
  const [newUuid, setNewUuid] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<TagMapping | null>(null);

  useEffect(() => {
    api<{ lands: RowPickerLand[] }>("/api/mobile/greenhouse-rows").then((r) => setRowLands(r.lands)).catch(() => {});
    api<{ carriers: PickerCarrier[] }>("/api/mobile/carriers").then((r) => setCarriers(r.carriers)).catch(() => {});
    isNfcSupported().then(setNfcAvailable);
  }, []);

  // Detects whatever tag is presented (step "scan-blank") — stops itself
  // once one is seen; "verify" (after a successful write) starts a fresh
  // session the same way to capture the re-tap.
  useEffect(() => {
    if (step !== "scan-blank" && step !== "verify") return;
    const stop = startScanSession((tag) => {
      if (step === "scan-blank") {
        setDetectedTag(tag);
        stop();
        setStep("confirm-overwrite");
      } else {
        stop();
        if (tag.labourlinkTagUuid === newUuid) {
          submitWriteMapping();
        } else {
          setVerifyError(
            tag.hardwareId === detectedTag?.hardwareId
              ? "Verification failed — the tag doesn't show the ID that was just written. Try writing again."
              : "A different tag was tapped. Tap the same tag that was just written to verify it."
          );
        }
      }
    });
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  function chooseType(type: TargetType) {
    setTargetType(type);
    setStep("choose-target");
  }

  function onTargetConfirm(id: string, label: string) {
    setTargetId(id);
    setTargetLabel(label);
    setDetectedTag(null);
    setNewUuid(null);
    setWriteError(null);
    setVerifyError(null);
    setStep("scan-blank");
  }

  async function performWrite() {
    if (!detectedTag) return;
    setStep("writing");
    setWriteError(null);
    const generated = uuid();
    const result = await writeTag(generated, { isWritable: detectedTag.isWritable, maxSize: detectedTag.maxSize });
    if (!result.ok) {
      setWriteError(result.message);
      setStep("confirm-overwrite");
      return;
    }
    setNewUuid(generated);
    setVerifyError(null);
    setStep("verify");
  }

  async function submitWriteMapping(confirmReplaceTarget?: boolean) {
    if (!targetType || !targetId || !newUuid) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await api("/api/mobile/tags/write-mapping", {
        method: "POST",
        body: JSON.stringify({ targetType, targetId, labourlinkTagUuid: newUuid, confirmReplaceTarget }),
      });
      setStep("done");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.body && typeof err.body === "object") {
        const body = err.body as { targetConflict?: TagMapping | null };
        setConflict(body.targetConflict ?? null);
        setStep("conflict");
      } else {
        setSubmitError(err instanceof Error ? err.message : "Could not save this tag's mapping.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  function reset() {
    setStep("choose-type");
    setTargetType(null);
    setTargetId(null);
    setTargetLabel(null);
    setDetectedTag(null);
    setNewUuid(null);
    setWriteError(null);
    setVerifyError(null);
    setConflict(null);
    setSubmitError(null);
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

  return (
    <div className="mobile-settings">
      <h1>Write New Tag</h1>
      <Link to="/mobile/settings" className="mobile-action-button mobile-action-secondary">
        Back to Settings
      </Link>

      {step === "choose-type" && (
        <section className="mobile-settings-device-section">
          <h2>What does this tag go on?</h2>
          <div className="mobile-confirm-actions">
            <button type="button" className="mobile-action-button mobile-action-primary" onClick={() => chooseType("greenhouse_row")}>
              Row
            </button>
            <button type="button" className="mobile-action-button mobile-action-primary" onClick={() => chooseType("carrier")}>
              Bin
            </button>
          </div>
        </section>
      )}

      {step === "choose-target" && targetType === "greenhouse_row" && (
        <RowPickerSheet
          activityName=""
          questionLabel="Select the row"
          allowSkip={false}
          lands={rowLands}
          error={null}
          busy={false}
          onConfirm={(rowId) => {
            const row = rowLands?.flatMap((l) => l.phases).flatMap((p) => p.rows).find((r) => r.id === rowId);
            onTargetConfirm(rowId, row ? `Row ${row.rowNumber}` : "Selected row");
          }}
          onSkip={() => {}}
          onCancel={() => setStep("choose-type")}
          language="en"
        />
      )}
      {step === "choose-target" && targetType === "carrier" && (
        <CarrierPickerSheet
          activityName=""
          questionLabel="Select the bin"
          allowSkip={false}
          carriers={carriers}
          error={null}
          busy={false}
          onConfirm={(carrierId) => {
            const c = carriers?.find((x) => x.id === carrierId);
            onTargetConfirm(carrierId, c?.name ?? "Selected bin");
          }}
          onSkip={() => {}}
          onCancel={() => setStep("choose-type")}
          language="en"
        />
      )}

      {step === "scan-blank" && (
        <section className="mobile-settings-device-section">
          <h2>Tap the blank tag</h2>
          <p className="mobile-settings-device-note">Target: {targetLabel}</p>
          {nfcAvailable === false && <p className="error-text">This phone does not have NFC available.</p>}
          <p className="mobile-settings-device-note">Hold the tag near the back of the phone…</p>
        </section>
      )}

      {step === "confirm-overwrite" && detectedTag && (
        <section className="mobile-settings-device-section">
          <h2>Tag detected</h2>
          <p className="mobile-settings-device-note">hardwareId: {detectedTag.hardwareId}</p>
          {detectedTag.isWritable === false ? (
            <p className="error-text">This tag is read-only and cannot be written to.</p>
          ) : (
            <>
              {detectedTag.hasNdefData ? (
                <p className="error-text">
                  This tag already has data on it{detectedTag.labourlinkTagUuid ? " (an existing LabourLink tag ID)" : ""}. Writing
                  will overwrite it. This cannot be undone.
                </p>
              ) : (
                <p className="mobile-settings-device-note">This tag appears blank.</p>
              )}
              {writeError && <p className="error-text">{writeError}</p>}
              <div className="mobile-confirm-actions">
                <button type="button" className="mobile-action-button mobile-action-primary" onClick={performWrite}>
                  {detectedTag.hasNdefData ? "Overwrite and write LabourLink tag" : "Write LabourLink tag"}
                </button>
                <button type="button" className="mobile-action-button" onClick={() => setStep("scan-blank")}>
                  Rescan a different tag
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {step === "writing" && (
        <section className="mobile-settings-device-section">
          <p className="mobile-settings-device-note">Writing…</p>
        </section>
      )}

      {step === "verify" && (
        <section className="mobile-settings-device-section">
          <h2>Verify</h2>
          <p className="mobile-settings-device-note">Tap the same tag again to confirm the write.</p>
          {verifyError && <p className="error-text">{verifyError}</p>}
        </section>
      )}

      {step === "conflict" && (
        <section className="mobile-settings-device-section">
          <h2>This would change an existing mapping</h2>
          <p className="mobile-settings-device-note">
            {targetLabel} already has a different active tag
            {conflict?.ridderHardwareId ? ` (Ridder ${conflict.ridderHardwareId})` : ""}. Confirming will replace it.
          </p>
          {submitError && <p className="error-text">{submitError}</p>}
          <div className="mobile-confirm-actions">
            <button
              type="button"
              className="mobile-action-button mobile-action-primary"
              disabled={submitting}
              onClick={() => submitWriteMapping(true)}
            >
              {submitting ? "Confirming…" : "Confirm and replace"}
            </button>
            <button type="button" className="mobile-action-button" disabled={submitting} onClick={reset}>
              Cancel
            </button>
          </div>
        </section>
      )}

      {step === "done" && (
        <section className="mobile-settings-device-section">
          <h2>Tag written and saved</h2>
          <p className="mobile-settings-device-note">
            A new LabourLink tag is now mapped to {targetLabel}.
          </p>
          <button type="button" className="mobile-action-button mobile-action-primary" onClick={reset}>
            Write another
          </button>
        </section>
      )}
    </div>
  );
}
