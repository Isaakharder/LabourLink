import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useWorkSession } from "../../context/WorkSessionContext";
import { api, ApiError } from "../../lib/api";
import { isNfcSupported, ScannedTag, startScanSession } from "../../lib/nfc";
import { TagMapping } from "../../lib/nfcTagTypes";
import { RowPickerSheet, RowPickerLand } from "../../components/mobile/RowPickerSheet";
import { CarrierPickerSheet, PickerCarrier } from "../../components/mobile/CarrierPickerSheet";

type TargetType = "greenhouse_row" | "carrier";
type Step = "choose-type" | "choose-target" | "scan" | "conflict" | "done";

// Admin-only (server-enforced via requireDeviceAdmin — see nfcTags.ts) —
// maps an *existing* Ridder tag to a row/bin by its stable hardware ID.
// Read-only toward the physical tag: nothing here ever calls write(),
// erase(), or makeReadOnly() on it. Plain English, no i18n — same
// convention as the rest of Settings (see i18n.ts's scope note).
export function RegisterExistingTagScreen() {
  const { me } = useWorkSession();
  const isAdmin = me?.employee.securityRole === "Administrator" || me?.employee.securityRole === "Manager";

  const [step, setStep] = useState<Step>("choose-type");
  const [targetType, setTargetType] = useState<TargetType | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [targetLabel, setTargetLabel] = useState<string | null>(null);
  const [rowLands, setRowLands] = useState<RowPickerLand[] | null>(null);
  const [carriers, setCarriers] = useState<PickerCarrier[] | null>(null);
  const [scannedTag, setScannedTag] = useState<ScannedTag | null>(null);
  const [nfcAvailable, setNfcAvailable] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ tagConflict: TagMapping | null; targetConflict: TagMapping | null } | null>(
    null
  );

  useEffect(() => {
    api<{ lands: RowPickerLand[] }>("/api/mobile/greenhouse-rows").then((r) => setRowLands(r.lands)).catch(() => {});
    api<{ carriers: PickerCarrier[] }>("/api/mobile/carriers").then((r) => setCarriers(r.carriers)).catch(() => {});
    isNfcSupported().then(setNfcAvailable);
  }, []);

  // Scans while step === "scan" — stops itself as soon as one tag is
  // captured (Rescan restarts it) rather than staying open, since only one
  // hardware ID is ever needed here.
  useEffect(() => {
    if (step !== "scan") return;
    const stop = startScanSession((tag) => {
      setScannedTag(tag);
      stop();
    });
    return stop;
  }, [step]);

  function chooseType(type: TargetType) {
    setTargetType(type);
    setStep("choose-target");
  }

  function onTargetConfirm(id: string, label: string) {
    setTargetId(id);
    setTargetLabel(label);
    setScannedTag(null);
    setError(null);
    setStep("scan");
  }

  async function submitRegister(confirmReplaceTag?: boolean, confirmReplaceTarget?: boolean) {
    if (!targetType || !targetId || !scannedTag) return;
    setSubmitting(true);
    setError(null);
    try {
      await api("/api/mobile/tags/register", {
        method: "POST",
        body: JSON.stringify({
          targetType,
          targetId,
          ridderHardwareId: scannedTag.hardwareId,
          confirmReplaceTag,
          confirmReplaceTarget,
        }),
      });
      setStep("done");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.body && typeof err.body === "object") {
        const body = err.body as { tagConflict?: TagMapping | null; targetConflict?: TagMapping | null };
        setConflict({ tagConflict: body.tagConflict ?? null, targetConflict: body.targetConflict ?? null });
        setStep("conflict");
      } else {
        setError(err instanceof Error ? err.message : "Could not register this tag.");
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
    setScannedTag(null);
    setConflict(null);
    setError(null);
  }

  if (!isAdmin) {
    return (
      <div className="mobile-settings">
        <h1>Register Existing Tag</h1>
        <p className="error-text">This screen requires an Administrator or Manager role.</p>
        <Link to="/mobile/settings" className="mobile-action-button mobile-action-secondary">
          Back to Settings
        </Link>
      </div>
    );
  }

  return (
    <div className="mobile-settings">
      <h1>Register Existing Tag</h1>
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
            const label = rowLands?.flatMap((l) => l.phases).flatMap((p) => p.rows).find((r) => r.id === rowId);
            onTargetConfirm(rowId, label ? `Row ${label.rowNumber}` : "Selected row");
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

      {step === "scan" && (
        <section className="mobile-settings-device-section">
          <h2>Scan the existing tag</h2>
          <p className="mobile-settings-device-note">Target: {targetLabel}</p>
          {nfcAvailable === false && <p className="error-text">This phone does not have NFC available.</p>}
          {error && <p className="error-text">{error}</p>}
          {!scannedTag ? (
            <p className="mobile-settings-device-note">Hold the tag near the back of the phone…</p>
          ) : (
            <>
              <p className="mobile-settings-device-note">
                hardwareId: {scannedTag.hardwareId}
                {scannedTag.labourlinkTagUuid && " — this is already a LabourLink tag, not a Ridder tag."}
              </p>
              <div className="mobile-confirm-actions">
                <button
                  type="button"
                  className="mobile-action-button mobile-action-primary"
                  disabled={submitting}
                  onClick={() => submitRegister()}
                >
                  {submitting ? "Registering…" : "Register this tag"}
                </button>
                <button type="button" className="mobile-action-button" disabled={submitting} onClick={() => setScannedTag(null)}>
                  Rescan
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {step === "conflict" && conflict && (
        <section className="mobile-settings-device-section">
          <h2>This would change an existing mapping</h2>
          {conflict.tagConflict && (
            <p className="mobile-settings-device-note">
              This tag is already registered to <strong>{conflict.tagConflict.label}</strong>. Confirming will move it to{" "}
              {targetLabel} instead.
            </p>
          )}
          {conflict.targetConflict && (
            <p className="mobile-settings-device-note">
              {targetLabel} already has a different active tag registered ({conflict.targetConflict.ridderHardwareId ?? "a LabourLink tag"}
              ). Confirming will replace it.
            </p>
          )}
          {error && <p className="error-text">{error}</p>}
          <div className="mobile-confirm-actions">
            <button
              type="button"
              className="mobile-action-button mobile-action-primary"
              disabled={submitting}
              onClick={() => submitRegister(Boolean(conflict.tagConflict), Boolean(conflict.targetConflict))}
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
          <h2>Registered</h2>
          <p className="mobile-settings-device-note">
            hardwareId {scannedTag?.hardwareId} is now mapped to {targetLabel}.
          </p>
          <button type="button" className="mobile-action-button mobile-action-primary" onClick={reset}>
            Register another
          </button>
        </section>
      )}
    </div>
  );
}
