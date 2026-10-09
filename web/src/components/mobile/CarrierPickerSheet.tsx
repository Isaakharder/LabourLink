import { useEffect, useMemo, useRef, useState } from "react";
import { Language, t } from "../../lib/i18n";
import { ScannedTag } from "../../lib/nfc";
import { resolveScannedTag, ResolvedTagTarget } from "../../lib/nfcMappingCache";
import { useForegroundNfcScan } from "../../lib/useForegroundNfcScan";
import { unknownTagMessageKey } from "../../lib/nfcActiveScreenScan";
import { isIosNativePlatform } from "../../lib/platform";

export interface PickerCarrier {
  id: string;
  name: string;
}

interface CarrierPickerSheetProps {
  activityName: string;
  questionLabel: string;
  // Present only inside a multi-question flow ("Step 1 of 2") — a
  // single-question activity's sheet omits it, same convention as
  // RowPickerSheet's stepLabel.
  stepLabel?: string;
  // True when the activity's question has is_required = false — shows a
  // "Skip" action that answers with no carrier. Required questions never
  // render Skip, so the sheet can't be dismissed into a started/changed
  // entry without a carrier.
  allowSkip: boolean;
  // Pre-selects a carrier when navigating back to this step in a
  // multi-question flow — undefined/null on first visit.
  initialSelectedCarrierId?: string | null;
  carriers: PickerCarrier[] | null; // null = still loading
  error: string | null;
  busy: boolean;
  onConfirm: (carrierId: string) => void;
  onSkip: () => void;
  onBack?: () => void;
  onCancel: () => void;
  language: Language;
  // See RowPickerSheet.tsx's identical prop for the full rationale.
  onNfcScan?: (resolved: ResolvedTagTarget) => void;
}

// Same bottom-sheet visual pattern and select-then-confirm interaction as
// RowPickerSheet (.mobile-sheet*/.mobile-row-grid* classes reused
// directly — a carrier list is just a flat, unphased version of the same
// "grid of tappable options, then Confirm" shape, so it doesn't need its
// own class family).
export function CarrierPickerSheet({
  activityName,
  questionLabel,
  stepLabel,
  allowSkip,
  initialSelectedCarrierId,
  carriers,
  error,
  busy,
  onConfirm,
  onSkip,
  onBack,
  onCancel,
  language,
  onNfcScan,
}: CarrierPickerSheetProps) {
  const [search, setSearch] = useState("");
  const [selectedCarrierId, setSelectedCarrierId] = useState<string | null>(initialSelectedCarrierId ?? null);
  const [nfcHint, setNfcHint] = useState<string | null>(null);

  // Same reasoning as RowPickerSheet's onNfcScanRef.
  const onNfcScanRef = useRef(onNfcScan);
  useEffect(() => {
    onNfcScanRef.current = onNfcScan;
  }, [onNfcScan]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel]);

  // Same NFC scan lifecycle as RowPickerSheet: auto-started on mount on
  // Android/web, tap-gated on iOS (see useForegroundNfcScan), stopped on
  // unmount, and a resolved tag only *selects* a carrier (same as a manual
  // tap) — never auto-confirms. See RowPickerSheet.tsx's matching effect for
  // the full rationale.
  const { scanning: nfcActive, awaitingTap: nfcAwaitingTap, startScan: startNfcScan } = useForegroundNfcScan({
    active: true,
    onTag: (tag: ScannedTag) => {
      const resolved = resolveScannedTag(tag);
      if (!resolved || resolved.targetType !== "carrier") {
        setNfcHint(t(language, unknownTagMessageKey(navigator.onLine, isIosNativePlatform())));
        return;
      }
      setNfcHint(null);

      if (onNfcScanRef.current) {
        onNfcScanRef.current(resolved);
        return;
      }

      setSelectedCarrierId(resolved.targetId);
    },
    onError: (message) => setNfcHint(message),
    label: "CarrierPickerSheet",
    iosAlertMessage: t(language, "tapBinTag"),
  });

  // Android/web only in practice — see RowPickerSheet.tsx's identical timer
  // for the full rationale.
  useEffect(() => {
    if (!nfcActive) return;
    const timer = setTimeout(() => setNfcHint((h) => h ?? t(language, "nfcStillWaiting")), 15000);
    return () => clearTimeout(timer);
  }, [nfcActive, language]);

  const filtered = useMemo(() => {
    if (!carriers) return null;
    const q = search.trim().toLowerCase();
    if (!q) return carriers;
    return carriers.filter((c) => c.name.toLowerCase().includes(q));
  }, [carriers, search]);

  function handleConfirm() {
    if (selectedCarrierId) onConfirm(selectedCarrierId);
  }

  return (
    <div className="mobile-sheet-backdrop" onClick={busy ? undefined : onCancel}>
      <div
        className="mobile-sheet"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={questionLabel}
      >
        <div className="mobile-sheet-header">
          <div>
            {stepLabel && <p className="mobile-step-indicator">{stepLabel}</p>}
            <h2>{questionLabel}</h2>
            <p className="mobile-row-picker-subtitle">{activityName}</p>
          </div>
          {!busy && (
            <button type="button" className="mobile-sheet-close" onClick={onCancel} aria-label={t(language, "close")}>
              ×
            </button>
          )}
        </div>

        {error && <p className="error-text">{error}</p>}
        {nfcActive && (
          <p className="mobile-row-picker-subtitle">{busy ? t(language, "starting") : nfcHint ?? t(language, "tapBinTag")}</p>
        )}
        {nfcAwaitingTap && (
          <div className="mobile-row-picker-subtitle">
            {nfcHint && <p className="mobile-row-picker-subtitle">{nfcHint}</p>}
            <button type="button" className="mobile-action-button mobile-action-primary" disabled={busy} onClick={startNfcScan}>
              {t(language, "scanButtonLabel")}
            </button>
          </div>
        )}

        {!carriers ? (
          <p className="mobile-sheet-empty">{t(language, "loadingCarriers")}</p>
        ) : carriers.length === 0 ? (
          <p className="mobile-sheet-empty">{t(language, "noCarriersMessage")}</p>
        ) : (
          <>
            <div className="mobile-row-search">
              <input
                type="search"
                placeholder={t(language, "searchCarrier")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                disabled={busy}
              />
            </div>

            {filtered && filtered.length === 0 ? (
              <p className="mobile-sheet-empty">{t(language, "noMatchingCarriers")}</p>
            ) : (
              <div className="mobile-row-grid">
                {filtered?.map((c) => {
                  const selected = c.id === selectedCarrierId;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className={`mobile-row-grid-item${selected ? " mobile-row-grid-item-selected" : ""}`}
                      disabled={busy}
                      onClick={() => setSelectedCarrierId(c.id)}
                    >
                      <span className="mobile-row-grid-item-number">{c.name}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}

        <div className="mobile-confirm-actions">
          {carriers && carriers.length > 0 && (
            <button
              type="button"
              className="mobile-action-button mobile-action-primary"
              disabled={busy || !selectedCarrierId}
              onClick={handleConfirm}
            >
              {busy ? t(language, "starting") : t(language, "confirm")}
            </button>
          )}
          {allowSkip && (
            <button type="button" className="mobile-action-button" disabled={busy} onClick={onSkip}>
              {t(language, "skipNoCarrier")}
            </button>
          )}
          {onBack && (
            <button type="button" className="mobile-action-button" disabled={busy} onClick={onBack}>
              {t(language, "back")}
            </button>
          )}
          <button type="button" className="mobile-action-button" disabled={busy} onClick={onCancel}>
            {t(language, "cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
