import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useWorkSession } from "../../context/WorkSessionContext";
import { api, ApiError } from "../../lib/api";
import { isNfcSupported, ScannedTag, startScanSession } from "../../lib/nfc";
import { playSuccessFeedback } from "../../lib/feedback";
import { TagMapping } from "../../lib/nfcTagTypes";
import { RowPickerSheet, RowPickerLand } from "../../components/mobile/RowPickerSheet";
import { CarrierPickerSheet, PickerCarrier } from "../../components/mobile/CarrierPickerSheet";

type TargetType = "greenhouse_row" | "carrier";
type Step = "choose-type" | "choose-target" | "scan" | "conflict";

// Admin-only (server-enforced via requireDeviceAdmin — see nfcTags.ts) —
// maps an *existing* Ridder tag to a row/bin by its stable hardware ID.
// Read-only toward the physical tag: nothing here ever calls write(),
// erase(), or makeReadOnly() on it. Plain English, no i18n — same
// convention as the rest of Settings (see i18n.ts's scope note).
//
// An unmapped tag registers the instant it's scanned — no confirmation
// modal for the normal path (see the NFC feature plan's "remove
// unnecessary confirmations while preserving targeted mistake
// protection"). Only a real conflict (this tag already mapped elsewhere, or
// this target already carrying a different tag) still stops for an
// explicit confirm, via the server's existing 409 tagConflict/
// targetConflict response — that safety check is unchanged.
export function RegisterExistingTagScreen() {
  const { me } = useWorkSession();
  const isAdmin = me?.employee.securityRole === "Administrator" || me?.employee.securityRole === "Manager";

  const [step, setStep] = useState<Step>("choose-type");
  const [targetType, setTargetType] = useState<TargetType | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [targetLabel, setTargetLabel] = useState<string | null>(null);
  const [rowLands, setRowLands] = useState<RowPickerLand[] | null>(null);
  const [carriers, setCarriers] = useState<PickerCarrier[] | null>(null);
  const [nfcAvailable, setNfcAvailable] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ tagConflict: TagMapping | null; targetConflict: TagMapping | null } | null>(
    null
  );
  const [pendingHardwareId, setPendingHardwareId] = useState<string | null>(null);
  // Transient green success banner — see the effect below that clears it
  // after a couple of seconds. Set right before returning to choose-target,
  // so the admin sees confirmation while already free to pick the next row.
  const [successBanner, setSuccessBanner] = useState<string | null>(null);
  // Bumped to force a fresh scan session after a non-conflict error (the
  // scan effect below only restarts on an actual `step` change, but "try
  // again" here doesn't otherwise change step away from "scan").
  const [scanGeneration, setScanGeneration] = useState(0);

  useEffect(() => {
    api<{ lands: RowPickerLand[] }>("/api/mobile/greenhouse-rows").then((r) => setRowLands(r.lands)).catch(() => {});
    api<{ carriers: PickerCarrier[] }>("/api/mobile/carriers").then((r) => setCarriers(r.carriers)).catch(() => {});
    isNfcSupported().then(setNfcAvailable);
  }, []);

  useEffect(() => {
    if (!successBanner) return;
    const timer = setTimeout(() => setSuccessBanner(null), 2500);
    return () => clearTimeout(timer);
  }, [successBanner]);

  // Scans while step === "scan" — each tag detected stops the session
  // (duplicate-suppression: holding the tag against the phone can only ever
  // trigger one registration attempt) and immediately attempts to register
  // it, no manual confirm step for the normal path. scanGeneration lets an
  // error's "Try again" reopen a fresh session without changing `step`.
  useEffect(() => {
    if (step !== "scan") return;
    const stop = startScanSession((tag) => {
      stop();
      void handleScanAndRegister(tag);
    });
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, scanGeneration]);

  async function handleScanAndRegister(tag: ScannedTag, confirmReplaceTag?: boolean, confirmReplaceTarget?: boolean) {
    if (!targetType || !targetId || submitting) return;
    setPendingHardwareId(tag.hardwareId);
    setSubmitting(true);
    setError(null);
    try {
      await api("/api/mobile/tags/register", {
        method: "POST",
        body: JSON.stringify({
          targetType,
          targetId,
          ridderHardwareId: tag.hardwareId,
          confirmReplaceTag,
          confirmReplaceTarget,
        }),
      });
      playSuccessFeedback();
      setSuccessBanner(targetLabel);
      setConflict(null);
      // Return focus to the row/bin selector immediately, same targetType,
      // so the admin can select the next row and scan again right away.
      setTargetId(null);
      setTargetLabel(null);
      setPendingHardwareId(null);
      setStep("choose-target");
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

  function chooseType(type: TargetType) {
    setTargetType(type);
    setStep("choose-target");
  }

  function onTargetConfirm(id: string, label: string) {
    setTargetId(id);
    setTargetLabel(label);
    setPendingHardwareId(null);
    setError(null);
    setStep("scan");
  }

  function reset() {
    setStep("choose-type");
    setTargetType(null);
    setTargetId(null);
    setTargetLabel(null);
    setPendingHardwareId(null);
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

      {successBanner && (
        <div
          style={{
            position: "fixed",
            top: 12,
            left: 12,
            right: 12,
            zIndex: 1000,
            background: "#1a7f37",
            color: "#fff",
            borderRadius: 8,
            padding: "12px 16px",
            fontWeight: 600,
            textAlign: "center",
          }}
        >
          ✓ {successBanner} registered
        </div>
      )}

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
          {submitting ? (
            <p className="mobile-settings-device-note">Registering hardwareId {pendingHardwareId}…</p>
          ) : error ? (
            <>
              <p className="error-text">{error}</p>
              <button
                type="button"
                className="mobile-action-button mobile-action-primary"
                onClick={() => {
                  setError(null);
                  setScanGeneration((g) => g + 1);
                }}
              >
                Try again
              </button>
            </>
          ) : (
            <p className="mobile-settings-device-note">Hold the tag near the back of the phone…</p>
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
              disabled={submitting || !pendingHardwareId}
              onClick={() => {
                if (!pendingHardwareId) return;
                void handleScanAndRegister(
                  { hardwareId: pendingHardwareId, labourlinkTagUuid: null, hasNdefData: false, isWritable: null, maxSize: null },
                  Boolean(conflict.tagConflict),
                  Boolean(conflict.targetConflict)
                );
              }}
            >
              {submitting ? "Confirming…" : "Confirm and replace"}
            </button>
            <button type="button" className="mobile-action-button" disabled={submitting} onClick={reset}>
              Cancel
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
