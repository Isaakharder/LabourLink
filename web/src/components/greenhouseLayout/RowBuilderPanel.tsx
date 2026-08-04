import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../../lib/api";
import { GreenhousePhase, GreenhouseRow, GreenhouseRowBatch } from "../../lib/greenhouseLayoutTypes";
import { BatchParams, RowRect, Side, NumberingMode, generateRowPreview, detectRowOverlap } from "../../lib/rowLayout";

interface RowBuilderPanelProps {
  phase: GreenhousePhase;
  savedRows: GreenhouseRow[];
  batches: GreenhouseRowBatch[];
  onClose: () => void;
  onSaved: () => void;
  onPreviewRowsChange: (rows: RowRect[]) => void;
}

const SIDE_OPTIONS: { value: Side; label: string }[] = [
  { value: "north", label: "North" },
  { value: "south", label: "South" },
  { value: "east", label: "East" },
  { value: "west", label: "West" },
];

const NUMBERING_OPTIONS: { value: NumberingMode; label: string }[] = [
  { value: "all", label: "All numbers" },
  { value: "odd", label: "Odd only" },
  { value: "even", label: "Even only" },
];

// Anchor side options are whichever two sides are perpendicular to the
// chosen start side — see the mapping table in lib/rowLayout.ts.
function anchorOptionsFor(startSide: Side): Side[] {
  return startSide === "north" || startSide === "south" ? ["east", "west"] : ["north", "south"];
}

function toRowRect(r: GreenhouseRow): RowRect {
  return { rowNumber: r.rowNumber, xFt: r.xFt, yFt: r.yFt, widthFt: r.widthFt, lengthFt: r.lengthFt, orientation: r.orientation };
}

export function RowBuilderPanel({ phase, savedRows, batches, onClose, onSaved, onPreviewRowsChange }: RowBuilderPanelProps) {
  const [name, setName] = useState("");
  const [startSide, setStartSide] = useState<Side>("south");
  const [anchorSide, setAnchorSide] = useState<Side>("east");
  const [rowWidthFt, setRowWidthFt] = useState("4");
  const [rowLengthFt, setRowLengthFt] = useState("");
  const [rowGapFt, setRowGapFt] = useState("0");
  const [offsetFt, setOffsetFt] = useState("0");
  const [numberingMode, setNumberingMode] = useState<NumberingMode>("odd");
  const [startRowNumber, setStartRowNumber] = useState("1");
  const [endRowNumber, setEndRowNumber] = useState("");
  const [continueAfterExisting, setContinueAfterExisting] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [renamingBatchId, setRenamingBatchId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deletingBatchId, setDeletingBatchId] = useState<string | null>(null);
  const [confirmingDeleteBatchId, setConfirmingDeleteBatchId] = useState<string | null>(null);
  const [batchActionError, setBatchActionError] = useState<string | null>(null);

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

  const preview = useMemo(
    () => generateRowPreview(params, phaseSize, { continueAfterExisting, existingRowsSameStartSide }),
    [params, phaseSize, continueAfterExisting, existingRowsSameStartSide]
  );

  // Live validation beyond what generateRowPreview alone can see: overlap
  // and duplicate numbers against every OTHER saved row in the phase (not
  // just ones sharing this batch's start side).
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

  useEffect(() => {
    onPreviewRowsChange(preview.rows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview.rows]);

  useEffect(() => {
    // Clear the live preview from the canvas once this panel unmounts.
    return () => onPreviewRowsChange([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSave() {
    if (allErrors.length > 0 || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await api(`/api/greenhouse-layout/phases/${phase.id}/row-batches`, {
        method: "POST",
        body: JSON.stringify({
          name: name.trim() || null,
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
      // Reset the whole form, not just the name — leaving the just-submitted
      // side/numbering/etc. in place would recompute the live preview
      // against the rows THIS save just created (onSaved() below refreshes
      // savedRows), which — for a "continue after existing" batch especially
      // — immediately shows a confusing "would overlap/fall outside bounds"
      // warning about a save that already succeeded.
      setName("");
      setStartSide("south");
      setAnchorSide("east");
      setRowWidthFt("4");
      setRowLengthFt("");
      setRowGapFt("0");
      setOffsetFt("0");
      setNumberingMode("odd");
      setStartRowNumber("1");
      setEndRowNumber("");
      setContinueAfterExisting(false);
      onSaved();
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : "Could not save this row batch");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRenameBatch(batchId: string) {
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setBatchActionError("Batch name cannot be empty");
      return;
    }
    try {
      await api(`/api/greenhouse-layout/row-batches/${batchId}`, { method: "PATCH", body: JSON.stringify({ name: trimmed }) });
      setRenamingBatchId(null);
      setBatchActionError(null);
      onSaved();
    } catch (err) {
      setBatchActionError(err instanceof ApiError ? err.message : "Could not rename this batch");
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

  return (
    <div className="row-builder-panel">
      <div className="row-builder-header">
        <h4>Add/Edit Rows — {phase.name}</h4>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="row-builder-form">
        <label>
          Batch name
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. South East Rows" />
        </label>

        <div className="row-builder-form-grid">
          <label>
            Start side
            <select value={startSide} onChange={(e) => setStartSide(e.target.value as Side)}>
              {SIDE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Anchor / connects to
            <select value={anchorSide} onChange={(e) => setAnchorSide(e.target.value as Side)}>
              {anchorOptionsFor(startSide).map((s) => (
                <option key={s} value={s}>
                  {SIDE_OPTIONS.find((o) => o.value === s)!.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            Row width (ft)
            <input type="number" min="0" step="any" value={rowWidthFt} onChange={(e) => setRowWidthFt(e.target.value)} />
          </label>
          <label>
            Row length (ft)
            <input type="number" min="0" step="any" value={rowLengthFt} onChange={(e) => setRowLengthFt(e.target.value)} />
          </label>

          <label>
            Row gap (ft)
            <input type="number" min="0" step="any" value={rowGapFt} onChange={(e) => setRowGapFt(e.target.value)} />
          </label>
          <label>
            Offset from edge (ft)
            <input type="number" min="0" step="any" value={offsetFt} onChange={(e) => setOffsetFt(e.target.value)} />
          </label>

          <label>
            Numbering
            <select value={numberingMode} onChange={(e) => setNumberingMode(e.target.value as NumberingMode)}>
              {NUMBERING_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <div />

          <label>
            Start row number
            <input type="number" min="1" step="1" value={startRowNumber} onChange={(e) => setStartRowNumber(e.target.value)} />
          </label>
          <label>
            End row number
            <input type="number" min="1" step="1" value={endRowNumber} onChange={(e) => setEndRowNumber(e.target.value)} />
          </label>
        </div>

        <label className="row-builder-continue">
          <input type="checkbox" checked={continueAfterExisting} onChange={(e) => setContinueAfterExisting(e.target.checked)} />
          Continue from the last row on this side (don't overlap prior batches)
        </label>

        {preview.rows.length > 0 && (
          <p className="row-builder-preview-summary">
            Preview: {preview.rows.length} row{preview.rows.length === 1 ? "" : "s"} (
            {preview.rowNumbers[0]}
            {preview.rowNumbers.length > 1 ? `–${preview.rowNumbers[preview.rowNumbers.length - 1]}` : ""})
          </p>
        )}

        {allErrors.length > 0 && (
          <div className="form-warning">
            {allErrors.map((e) => (
              <p key={e}>{e}</p>
            ))}
          </div>
        )}
        {submitError && <p className="error-text">{submitError}</p>}

        <div className="row-builder-form-actions">
          <button type="button" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="employees-add-button"
            onClick={handleSave}
            disabled={submitting || allErrors.length > 0 || preview.rows.length === 0}
          >
            {submitting ? "Saving..." : "Save Rows"}
          </button>
        </div>
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
                {renamingBatchId === b.id ? (
                  <div className="row-builder-batch-rename">
                    <input type="text" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} autoFocus />
                    <button type="button" onClick={() => handleRenameBatch(b.id)}>
                      Save
                    </button>
                    <button type="button" onClick={() => setRenamingBatchId(null)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="row-builder-batch-info">
                      <strong>{b.name ?? `Rows ${b.startRowNumber}–${b.endRowNumber}`}</strong>
                      <span>
                        {SIDE_OPTIONS.find((o) => o.value === b.startSide)!.label} → {SIDE_OPTIONS.find((o) => o.value === b.anchorSide)!.label}
                        {" · "}#{b.startRowNumber}–{b.endRowNumber} ({b.numberingMode})
                        {" · "}
                        {rowCountByBatch.get(b.id) ?? 0} row{(rowCountByBatch.get(b.id) ?? 0) === 1 ? "" : "s"}
                        {" · "}
                        {b.rowWidthFt}×{b.rowLengthFt} ft
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
                        <button
                          type="button"
                          onClick={() => {
                            setRenamingBatchId(b.id);
                            setRenameValue(b.name ?? "");
                          }}
                        >
                          Rename
                        </button>
                        <button type="button" className="row-builder-batch-delete" onClick={() => setConfirmingDeleteBatchId(b.id)}>
                          Delete
                        </button>
                      </div>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
