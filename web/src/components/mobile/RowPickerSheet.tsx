import { useEffect, useMemo, useState } from "react";

export interface RowPickerRow {
  id: string;
  rowNumber: number;
}

export interface RowPickerPhase {
  id: string;
  name: string;
  rows: RowPickerRow[];
}

export interface RowPickerLand {
  id: string;
  name: string;
  phases: RowPickerPhase[];
}

interface RowPickerSheetProps {
  activityName: string;
  questionLabel: string;
  // True when the activity's question has is_required = false — shows a
  // "Skip" action that starts the activity with greenhouseRowId = null.
  // Required questions never render Skip, so the sheet can't be dismissed
  // into a started entry without a row.
  allowSkip: boolean;
  lands: RowPickerLand[] | null; // null = still loading
  error: string | null;
  busy: boolean;
  onConfirm: (rowId: string) => void;
  onSkip: () => void;
  onCancel: () => void;
}

export const NO_ROWS_MESSAGE = "No greenhouse rows configured. Contact your supervisor.";

// Same bottom-sheet visual pattern as ActivityPicker/ConfirmEndDayModal
// (.mobile-sheet* classes) for consistency. Two-step select-then-confirm
// (tap highlights, Confirm submits) rather than submit-on-tap — this opens
// a real work entry, so a tap should be reviewable before it commits.
export function RowPickerSheet({
  activityName,
  questionLabel,
  allowSkip,
  lands,
  error,
  busy,
  onConfirm,
  onSkip,
  onCancel,
}: RowPickerSheetProps) {
  const [selectedLandId, setSelectedLandId] = useState<string | null>(null);
  const [expandedPhaseId, setExpandedPhaseId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);

  // Auto-select the only land once loaded — most greenhouses have exactly
  // one, and there's no reason to make the employee tap through an extra
  // screen for it.
  useEffect(() => {
    if (lands && lands.length === 1 && !selectedLandId) {
      setSelectedLandId(lands[0].id);
    }
  }, [lands, selectedLandId]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel]);

  const land = lands?.find((l) => l.id === selectedLandId) ?? null;

  const searchResults = useMemo(() => {
    if (!land || !search.trim()) return null;
    const q = search.trim();
    const results: { phaseName: string; row: RowPickerRow }[] = [];
    for (const phase of land.phases) {
      for (const row of phase.rows) {
        if (String(row.rowNumber).startsWith(q)) {
          results.push({ phaseName: phase.name, row });
        }
      }
    }
    return results;
  }, [land, search]);

  const expandedPhase = land?.phases.find((p) => p.id === expandedPhaseId) ?? null;
  const multiLand = Boolean(lands && lands.length > 1);
  const showBack = Boolean(expandedPhase) || (multiLand && land && !expandedPhase);

  function handleBack() {
    if (expandedPhase) setExpandedPhaseId(null);
    else if (multiLand) setSelectedLandId(null);
  }

  function handleConfirm() {
    if (selectedRowId) onConfirm(selectedRowId);
  }

  function rowButton(row: RowPickerRow, phaseName?: string) {
    const selected = row.id === selectedRowId;
    return (
      <button
        key={row.id}
        type="button"
        className={`mobile-row-grid-item${selected ? " mobile-row-grid-item-selected" : ""}`}
        disabled={busy}
        onClick={() => setSelectedRowId(row.id)}
      >
        <span className="mobile-row-grid-item-number">{row.rowNumber}</span>
        {phaseName && <span className="mobile-row-grid-item-phase">{phaseName}</span>}
      </button>
    );
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

        {!lands ? (
          <p className="mobile-sheet-empty">Loading rows…</p>
        ) : lands.length === 0 ? (
          <p className="mobile-sheet-empty">{NO_ROWS_MESSAGE}</p>
        ) : !land ? (
          // Only reached when there's more than one land.
          <div className="mobile-sheet-list">
            {lands.map((l) => (
              <button
                key={l.id}
                type="button"
                className="mobile-action-button mobile-sheet-item"
                onClick={() => setSelectedLandId(l.id)}
              >
                <span className="mobile-sheet-item-name">{l.name}</span>
              </button>
            ))}
          </div>
        ) : (
          <>
            <div className="mobile-row-search">
              <input
                type="search"
                inputMode="numeric"
                placeholder="Search row number"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                disabled={busy}
              />
            </div>

            {showBack && !search && (
              <button type="button" className="mobile-row-back" onClick={handleBack} disabled={busy}>
                ← Back
              </button>
            )}

            {searchResults ? (
              searchResults.length === 0 ? (
                <p className="mobile-sheet-empty">No matching rows</p>
              ) : (
                <div className="mobile-row-grid">
                  {searchResults.map(({ row, phaseName }) => rowButton(row, phaseName))}
                </div>
              )
            ) : expandedPhase ? (
              expandedPhase.rows.length === 0 ? (
                <p className="mobile-sheet-empty">No rows in this phase</p>
              ) : (
                <div className="mobile-row-grid">{expandedPhase.rows.map((row) => rowButton(row))}</div>
              )
            ) : land.phases.length === 0 ? (
              <p className="mobile-sheet-empty">{NO_ROWS_MESSAGE}</p>
            ) : (
              <div className="mobile-sheet-list">
                {land.phases.map((phase) => (
                  <button
                    key={phase.id}
                    type="button"
                    className="mobile-action-button mobile-sheet-item"
                    disabled={busy}
                    onClick={() => setExpandedPhaseId(phase.id)}
                  >
                    <span className="mobile-sheet-item-name">{phase.name}</span>
                    <span className="mobile-sheet-item-secondary">{phase.rows.length} rows</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {/* Rendered regardless of loading/empty/land-selection state — Skip
            never depends on rows having loaded, and Cancel must always be
            reachable. Confirm only makes sense once a row can be selected. */}
        <div className="mobile-confirm-actions">
          {land && (
            <button
              type="button"
              className="mobile-action-button mobile-action-primary"
              disabled={busy || !selectedRowId}
              onClick={handleConfirm}
            >
              {busy ? "Starting…" : "Confirm"}
            </button>
          )}
          {allowSkip && (
            <button type="button" className="mobile-action-button" disabled={busy} onClick={onSkip}>
              Skip — No row
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
