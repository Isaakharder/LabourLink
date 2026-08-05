import { useEffect, useMemo, useState } from "react";

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
}

export const NO_CARRIERS_MESSAGE = "No carriers configured. Contact your supervisor.";

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
}: CarrierPickerSheetProps) {
  const [search, setSearch] = useState("");
  const [selectedCarrierId, setSelectedCarrierId] = useState<string | null>(initialSelectedCarrierId ?? null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel]);

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
            <button type="button" className="mobile-sheet-close" onClick={onCancel} aria-label="Close">
              ×
            </button>
          )}
        </div>

        {error && <p className="error-text">{error}</p>}

        {!carriers ? (
          <p className="mobile-sheet-empty">Loading carriers…</p>
        ) : carriers.length === 0 ? (
          <p className="mobile-sheet-empty">{NO_CARRIERS_MESSAGE}</p>
        ) : (
          <>
            <div className="mobile-row-search">
              <input
                type="search"
                placeholder="Search carrier"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                disabled={busy}
              />
            </div>

            {filtered && filtered.length === 0 ? (
              <p className="mobile-sheet-empty">No matching carriers</p>
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
              {busy ? "Starting…" : "Confirm"}
            </button>
          )}
          {allowSkip && (
            <button type="button" className="mobile-action-button" disabled={busy} onClick={onSkip}>
              Skip — No carrier
            </button>
          )}
          {onBack && (
            <button type="button" className="mobile-action-button" disabled={busy} onClick={onBack}>
              Back
            </button>
          )}
          <button type="button" className="mobile-action-button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
