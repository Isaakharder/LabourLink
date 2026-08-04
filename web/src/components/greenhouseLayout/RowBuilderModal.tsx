import { useEffect, useMemo, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import { GreenhousePhase, GreenhouseRow, GreenhouseRowBatch } from "../../lib/greenhouseLayoutTypes";
import { BatchParams, RowRect, Side, NumberingMode, generateRowPreview, detectRowOverlap } from "../../lib/rowLayout";

interface RowBuilderModalProps {
  phase: GreenhousePhase;
  savedRows: GreenhouseRow[];
  batches: GreenhouseRowBatch[];
  onClose: () => void;
  onSaved: () => void;
  onPreviewChange: (rows: RowRect[], valid: boolean) => void;
}

const SIDE_LABEL: Record<Side, string> = { north: "North", south: "South", east: "East", west: "West" };
const SIDE_OPTIONS: Side[] = ["north", "south", "east", "west"];

const NUMBERING_OPTIONS: { value: NumberingMode; label: string }[] = [
  { value: "all", label: "All numbers" },
  { value: "odd", label: "Odd only" },
  { value: "even", label: "Even only" },
];

// Field-level messages generateRowPreview already produces (see
// rowLayout.ts) — filtered out of the compact cross-field summary box
// because each has its own inline field error instead. Purely a display
// concern: the authoritative pass/fail gate for Save is still the full,
// unfiltered `allErrors` list below, unchanged from before.
const FIELD_ERROR_PREFIXES = [
  "Row width must be",
  "Row length must be",
  "Row gap must be",
  "Offset must be",
  "Start row number must be",
  "End row number must be",
];

const DEFAULTS = {
  startSide: "south" as Side,
  anchorSide: "east" as Side,
  rowWidthFt: "4",
  rowLengthFt: "",
  rowGapFt: "0",
  offsetFt: "0",
  numberingMode: "odd" as NumberingMode,
  startRowNumber: "1",
  endRowNumber: "",
  continueAfterExisting: false,
};

// Anchor side options are whichever two sides are perpendicular to the
// chosen start side — see the mapping table in lib/rowLayout.ts.
function anchorOptionsFor(startSide: Side): Side[] {
  return startSide === "north" || startSide === "south" ? ["east", "west"] : ["north", "south"];
}

function toRowRect(r: GreenhouseRow): RowRect {
  return { rowNumber: r.rowNumber, xFt: r.xFt, yFt: r.yFt, widthFt: r.widthFt, lengthFt: r.lengthFt, orientation: r.orientation };
}

function requiredPositiveError(value: string, label: string): string | null {
  if (value.trim() === "") return `${label} is required.`;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return `${label} must be greater than 0.`;
  return null;
}

function nonNegativeError(value: string, label: string): string | null {
  if (value.trim() === "") return null; // both have a "0" default; genuinely empty is unusual
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return `${label} must be 0 or greater.`;
  return null;
}

function positiveIntError(value: string, label: string): string | null {
  if (value.trim() === "") return `${label} is required.`;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return `${label} must be a whole number of 1 or greater.`;
  return null;
}

function endRowError(value: string, startValue: string): string | null {
  const base = positiveIntError(value, "End row number");
  if (base) return base;
  const n = Number(value);
  const s = Number(startValue);
  if (Number.isFinite(s) && n < s) return "End row number must be greater than or equal to the start row number.";
  return null;
}

export function RowBuilderModal({ phase, savedRows, batches, onClose, onSaved, onPreviewChange }: RowBuilderModalProps) {
  const [startSide, setStartSide] = useState<Side>(DEFAULTS.startSide);
  const [anchorSide, setAnchorSide] = useState<Side>(DEFAULTS.anchorSide);
  const [rowWidthFt, setRowWidthFt] = useState(DEFAULTS.rowWidthFt);
  const [rowLengthFt, setRowLengthFt] = useState(DEFAULTS.rowLengthFt);
  const [rowGapFt, setRowGapFt] = useState(DEFAULTS.rowGapFt);
  const [offsetFt, setOffsetFt] = useState(DEFAULTS.offsetFt);
  const [numberingMode, setNumberingMode] = useState<NumberingMode>(DEFAULTS.numberingMode);
  const [startRowNumber, setStartRowNumber] = useState(DEFAULTS.startRowNumber);
  const [endRowNumber, setEndRowNumber] = useState(DEFAULTS.endRowNumber);
  const [continueAfterExisting, setContinueAfterExisting] = useState(DEFAULTS.continueAfterExisting);

  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [deletingBatchId, setDeletingBatchId] = useState<string | null>(null);
  const [confirmingDeleteBatchId, setConfirmingDeleteBatchId] = useState<string | null>(null);
  const [batchActionError, setBatchActionError] = useState<string | null>(null);

  function touch(field: string) {
    setTouched((prev) => (prev.has(field) ? prev : new Set(prev).add(field)));
    setSuccessMessage(null);
  }

  // Anchor side must stay perpendicular to start side — flip to a valid
  // default whenever start side changes to something incompatible.
  useEffect(() => {
    const valid = anchorOptionsFor(startSide);
    if (!valid.includes(anchorSide)) setAnchorSide(valid[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startSide]);

  const params: BatchParams = useMemo(
    () => ({
      startSide,
      anchorSide,
      rowWidthFt: Number(rowWidthFt),
      rowLengthFt: Number(rowLengthFt),
      rowGapFt: Number(rowGapFt || 0),
      offsetFt: Number(offsetFt || 0),
      numberingMode,
      startRowNumber: Number(startRowNumber),
      endRowNumber: Number(endRowNumber),
    }),
    [startSide, anchorSide, rowWidthFt, rowLengthFt, rowGapFt, offsetFt, numberingMode, startRowNumber, endRowNumber]
  );

  const phaseSize = useMemo(() => ({ eastWestFeet: phase.eastWestFeet, northSouthFeet: phase.northSouthFeet }), [phase]);

  const existingRowsSameStartSide = useMemo(() => {
    const batchById = new Map(batches.map((b) => [b.id, b]));
    return savedRows.filter((r) => r.rowBatchId && batchById.get(r.rowBatchId)?.startSide === startSide).map(toRowRect);
  }, [savedRows, batches, startSide]);

  // Unchanged from before this UI refactor: the same placement/validation
  // engine, called the same way — only how its output is *displayed* below
  // has changed.
  const preview = useMemo(
    () => generateRowPreview(params, phaseSize, { continueAfterExisting, existingRowsSameStartSide }),
    [params, phaseSize, continueAfterExisting, existingRowsSameStartSide]
  );

  const crossChecks = useMemo(() => {
    if (preview.errors.length > 0 || preview.rows.length === 0) return [];
    const errs: string[] = [];
    const allSaved = savedRows.map(toRowRect);
    const savedNumbers = new Set(allSaved.map((r) => r.rowNumber));
    const duplicates = preview.rowNumbers.filter((n) => savedNumbers.has(n));
    if (duplicates.length > 0) errs.push(`Row number${duplicates.length > 1 ? "s" : ""} ${duplicates.join(", ")} already exist in this phase.`);
    const overlaps = detectRowOverlap(preview.rows, allSaved);
    if (overlaps.length > 0) {
      const [a, b] = overlaps[0];
      errs.push(`Row ${a.rowNumber} would overlap existing row ${b.rowNumber}.`);
    }
    return errs;
  }, [preview, savedRows]);

  const allErrors = [...preview.errors, ...crossChecks];
  const summaryErrors = allErrors.filter((e) => !FIELD_ERROR_PREFIXES.some((p) => e.startsWith(p)));

  const widthError = touched.has("rowWidthFt") ? requiredPositiveError(rowWidthFt, "Row width") : null;
  const lengthError = touched.has("rowLengthFt") ? requiredPositiveError(rowLengthFt, "Row length") : null;
  const gapError = touched.has("rowGapFt") ? nonNegativeError(rowGapFt, "Row gap") : null;
  const offsetError = touched.has("offsetFt") ? nonNegativeError(offsetFt, "Offset") : null;
  const startRowError = touched.has("startRowNumber") ? positiveIntError(startRowNumber, "Start row number") : null;
  const endRowErrorMsg = touched.has("endRowNumber") ? endRowError(endRowNumber, startRowNumber) : null;

  const occupiedBounds = useMemo(() => {
    if (preview.rows.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const r of preview.rows) {
      const w = r.orientation === "horizontal" ? r.lengthFt : r.widthFt;
      const h = r.orientation === "horizontal" ? r.widthFt : r.lengthFt;
      minX = Math.min(minX, r.xFt);
      maxX = Math.max(maxX, r.xFt + w);
      minY = Math.min(minY, r.yFt);
      maxY = Math.max(maxY, r.yFt + h);
    }
    return { width: Math.round((maxX - minX) * 10) / 10, depth: Math.round((maxY - minY) * 10) / 10 };
  }, [preview.rows]);

  useEffect(() => {
    onPreviewChange(preview.rows, allErrors.length === 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview.rows, allErrors.length]);

  useEffect(() => {
    // Clear the live preview from the canvas once this modal unmounts.
    return () => onPreviewChange([], true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isDirty =
    startSide !== DEFAULTS.startSide ||
    anchorSide !== DEFAULTS.anchorSide ||
    rowWidthFt !== DEFAULTS.rowWidthFt ||
    rowLengthFt !== DEFAULTS.rowLengthFt ||
    rowGapFt !== DEFAULTS.rowGapFt ||
    offsetFt !== DEFAULTS.offsetFt ||
    numberingMode !== DEFAULTS.numberingMode ||
    startRowNumber !== DEFAULTS.startRowNumber ||
    endRowNumber !== DEFAULTS.endRowNumber ||
    continueAfterExisting !== DEFAULTS.continueAfterExisting;

  function resetForm() {
    setStartSide(DEFAULTS.startSide);
    setAnchorSide(DEFAULTS.anchorSide);
    setRowWidthFt(DEFAULTS.rowWidthFt);
    setRowLengthFt(DEFAULTS.rowLengthFt);
    setRowGapFt(DEFAULTS.rowGapFt);
    setOffsetFt(DEFAULTS.offsetFt);
    setNumberingMode(DEFAULTS.numberingMode);
    setStartRowNumber(DEFAULTS.startRowNumber);
    setEndRowNumber(DEFAULTS.endRowNumber);
    setContinueAfterExisting(DEFAULTS.continueAfterExisting);
    setTouched(new Set());
  }

  // Backdrop click, Escape, and the header's × button all funnel through
  // Modal's one onClose prop — routing all three through this instead of
  // Modal.tsx itself is what makes "clicking outside" and "Escape" both
  // confirm before discarding, without changing Modal's behavior for any
  // of its other callers.
  function requestClose() {
    if (submitting) return;
    if (isDirty) {
      if (!window.confirm("Discard unsaved row batch changes?")) return;
    }
    onClose();
  }

  async function handleSave() {
    if (submitting) return;
    if (allErrors.length > 0) {
      // Surface every field's own message rather than leaving the admin
      // guessing which of several still-untouched fields is the problem.
      setTouched(new Set(["rowWidthFt", "rowLengthFt", "rowGapFt", "offsetFt", "startRowNumber", "endRowNumber"]));
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    setSuccessMessage(null);
    try {
      await api(`/api/greenhouse-layout/phases/${phase.id}/row-batches`, {
        method: "POST",
        body: JSON.stringify({
          startSide,
          anchorSide,
          rowWidthFt: params.rowWidthFt,
          rowLengthFt: params.rowLengthFt,
          rowGapFt: params.rowGapFt,
          offsetFt: params.offsetFt,
          numberingMode,
          startRowNumber: params.startRowNumber,
          endRowNumber: params.endRowNumber,
          continueAfterExisting,
        }),
      });
      const savedCount = preview.rows.length;
      resetForm();
      onSaved();
      // Stay open — batches are commonly added a few at a time (e.g. a
      // second, shorter continuation right after the first) — closing
      // after every save would mean reopening for each one.
      setSuccessMessage(`Saved ${savedCount} row${savedCount === 1 ? "" : "s"}. Add another batch, or close when done.`);
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : "Could not save this row batch");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeleteBatch(batchId: string) {
    setDeletingBatchId(batchId);
    setBatchActionError(null);
    try {
      await api(`/api/greenhouse-layout/row-batches/${batchId}`, { method: "DELETE" });
      setConfirmingDeleteBatchId(null);
      onSaved();
    } catch (err) {
      setBatchActionError(err instanceof ApiError ? err.message : "Could not delete this batch");
    } finally {
      setDeletingBatchId(null);
    }
  }

  const rowCountByBatch = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of savedRows) {
      if (!r.rowBatchId) continue;
      counts.set(r.rowBatchId, (counts.get(r.rowBatchId) ?? 0) + 1);
    }
    return counts;
  }, [savedRows]);

  const saveDisabled = submitting || allErrors.length > 0 || preview.rows.length === 0;

  return (
    <Modal
      title={`Add/Edit Rows — ${phase.name}`}
      onClose={requestClose}
      xl
      footer={
        <div className="row-builder-form-actions">
          <button type="button" onClick={requestClose} disabled={submitting}>
            Close
          </button>
          <button type="button" className="employees-add-button" onClick={handleSave} disabled={saveDisabled}>
            {submitting ? "Saving..." : "Save Rows"}
          </button>
        </div>
      }
    >
      <div className="row-builder-form">
        <div className="row-builder-group">
          <h5>Placement</h5>
          <div className="row-builder-group-grid">
            <label>
              Start side
              <select value={startSide} onChange={(e) => setStartSide(e.target.value as Side)}>
                {SIDE_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {SIDE_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Anchor side
              <select value={anchorSide} onChange={(e) => setAnchorSide(e.target.value as Side)}>
                {anchorOptionsFor(startSide).map((s) => (
                  <option key={s} value={s}>
                    {SIDE_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>

            <label className="row-builder-continue row-builder-field-span2">
              <input
                type="checkbox"
                checked={continueAfterExisting}
                onChange={(e) => {
                  setContinueAfterExisting(e.target.checked);
                  setSuccessMessage(null);
                }}
              />
              Continue from previous batch on this side
            </label>

            <label className={offsetError ? "row-builder-field-invalid" : ""}>
              Offset from side (ft)
              <input
                type="number"
                min="0"
                step="any"
                value={offsetFt}
                onChange={(e) => {
                  setOffsetFt(e.target.value);
                  touch("offsetFt");
                }}
              />
              {offsetError && <span className="row-builder-field-error">{offsetError}</span>}
            </label>
          </div>
        </div>

        <div className="row-builder-group">
          <h5>Dimensions</h5>
          <div className="row-builder-group-grid">
            <label className={widthError ? "row-builder-field-invalid" : ""}>
              Row width (ft)
              <input
                type="number"
                min="0"
                step="any"
                value={rowWidthFt}
                onChange={(e) => {
                  setRowWidthFt(e.target.value);
                  touch("rowWidthFt");
                }}
              />
              {widthError && <span className="row-builder-field-error">{widthError}</span>}
            </label>
            <label className={lengthError ? "row-builder-field-invalid" : ""}>
              Row length (ft)
              <input
                type="number"
                min="0"
                step="any"
                value={rowLengthFt}
                onChange={(e) => {
                  setRowLengthFt(e.target.value);
                  touch("rowLengthFt");
                }}
              />
              {lengthError && <span className="row-builder-field-error">{lengthError}</span>}
            </label>
            <label className={gapError ? "row-builder-field-invalid" : ""}>
              Row gap (ft)
              <input
                type="number"
                min="0"
                step="any"
                value={rowGapFt}
                onChange={(e) => {
                  setRowGapFt(e.target.value);
                  touch("rowGapFt");
                }}
              />
              {gapError && <span className="row-builder-field-error">{gapError}</span>}
            </label>
          </div>
        </div>

        <div className="row-builder-group">
          <h5>Numbering</h5>
          <div className="row-builder-group-grid">
            <label className="row-builder-field-span2">
              Numbering mode
              <select value={numberingMode} onChange={(e) => setNumberingMode(e.target.value as NumberingMode)}>
                {NUMBERING_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className={startRowError ? "row-builder-field-invalid" : ""}>
              Start row number
              <input
                type="number"
                min="1"
                step="1"
                value={startRowNumber}
                onChange={(e) => {
                  setStartRowNumber(e.target.value);
                  touch("startRowNumber");
                }}
              />
              {startRowError && <span className="row-builder-field-error">{startRowError}</span>}
            </label>
            <label className={endRowErrorMsg ? "row-builder-field-invalid" : ""}>
              End row number
              <input
                type="number"
                min="1"
                step="1"
                value={endRowNumber}
                onChange={(e) => {
                  setEndRowNumber(e.target.value);
                  touch("endRowNumber");
                }}
              />
              {endRowErrorMsg && <span className="row-builder-field-error">{endRowErrorMsg}</span>}
            </label>
          </div>
        </div>

        <div className="row-builder-group">
          <h5>Preview</h5>
          {preview.rows.length > 0 ? (
            <div className="row-builder-preview-stats">
              <span>
                <strong>{preview.rows.length}</strong> row{preview.rows.length === 1 ? "" : "s"} (#{preview.rowNumbers[0]}
                {preview.rowNumbers.length > 1 ? `–${preview.rowNumbers[preview.rowNumbers.length - 1]}` : ""})
              </span>
              {occupiedBounds && (
                <span>
                  Occupied: <strong>{occupiedBounds.width} ft</strong> wide × <strong>{occupiedBounds.depth} ft</strong> deep
                </span>
              )}
            </div>
          ) : (
            <p className="placeholder-page">Fill in the fields above to see a preview.</p>
          )}

          {summaryErrors.length > 0 && (
            <div className="row-builder-summary-box">
              {summaryErrors.map((e) => (
                <p key={e}>{e}</p>
              ))}
            </div>
          )}

          {successMessage && <p className="row-builder-success">{successMessage}</p>}
          {submitError && <p className="error-text">{submitError}</p>}
        </div>

        <div className="row-builder-batches">
          <h5>Saved batches</h5>
          {batchActionError && <p className="error-text">{batchActionError}</p>}
          {batches.length === 0 ? (
            <p className="placeholder-page">No row batches yet for this phase.</p>
          ) : (
            <ul className="row-builder-batch-list">
              {batches.map((b) => (
                <li key={b.id} className="row-builder-batch-item">
                  <div className="row-builder-batch-info">
                    <strong>
                      Rows {b.startRowNumber}–{b.endRowNumber}
                    </strong>
                    <span>
                      {SIDE_LABEL[b.startSide]} → {SIDE_LABEL[b.anchorSide]}
                    </span>
                    <span>
                      {rowCountByBatch.get(b.id) ?? 0} row{(rowCountByBatch.get(b.id) ?? 0) === 1 ? "" : "s"}
                      {" · "}
                      {b.rowWidthFt} ft wide · {b.rowLengthFt} ft long
                    </span>
                  </div>
                  {confirmingDeleteBatchId === b.id ? (
                    <div className="row-builder-batch-actions">
                      <span>Delete? All {rowCountByBatch.get(b.id) ?? 0} of its rows go too.</span>
                      <button type="button" onClick={() => setConfirmingDeleteBatchId(null)} disabled={deletingBatchId === b.id}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="row-builder-batch-delete"
                        onClick={() => handleDeleteBatch(b.id)}
                        disabled={deletingBatchId === b.id}
                      >
                        {deletingBatchId === b.id ? "Deleting..." : "Confirm Delete"}
                      </button>
                    </div>
                  ) : (
                    <div className="row-builder-batch-actions">
                      <button type="button" className="row-builder-batch-delete" onClick={() => setConfirmingDeleteBatchId(b.id)}>
                        Delete
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
