import { useState } from "react";
import { api, ApiError } from "../../lib/api";
import { GreenhouseRow } from "../../lib/greenhouseLayoutTypes";

const SIDE_LABELS: Record<string, string> = { north: "North", south: "South", east: "East", west: "West" };

interface RowDetailsPanelProps {
  row: GreenhouseRow;
  batchName: string | null;
  startSide: string | null;
  anchorSide: string | null;
  onDeleted: () => void;
  onClose: () => void;
}

// Shown instead of the phase action buttons whenever a saved row (not a
// phase) is the current selection — deliberately a separate, narrower
// panel rather than folding row details into the phase's own action block,
// so it's never ambiguous which object a button on screen actually acts on.
export function RowDetailsPanel({ row, batchName, startSide, anchorSide, onDeleted, onClose }: RowDetailsPanelProps) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await api(`/api/greenhouse-layout/rows/${row.id}`, { method: "DELETE" });
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete this row");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="row-details-panel">
      <div className="row-builder-header">
        <h4>Row {row.rowNumber}</h4>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>

      <dl className="row-details-list">
        <dt>Batch</dt>
        <dd>{batchName ?? "—"}</dd>
        <dt>Side / anchor</dt>
        <dd>{startSide ? `${SIDE_LABELS[startSide]} → ${SIDE_LABELS[anchorSide!]}` : "—"}</dd>
        <dt>Orientation</dt>
        <dd>{row.orientation}</dd>
        <dt>Width × Length</dt>
        <dd>
          {row.widthFt} ft × {row.lengthFt} ft
        </dd>
        <dt>Position in phase</dt>
        <dd>
          {Math.round(row.xFt * 10) / 10} ft east, {Math.round(row.yFt * 10) / 10} ft south of phase's NW corner
        </dd>
      </dl>

      {error && <p className="error-text">{error}</p>}

      {confirming ? (
        <div className="form-warning">
          <p>Delete row {row.rowNumber}? This cannot be undone from here; surrounding rows will not move or renumber.</p>
          <div className="row-builder-form-actions">
            <button type="button" onClick={() => setConfirming(false)} disabled={deleting}>
              Cancel
            </button>
            <button type="button" className="row-builder-batch-delete" onClick={handleDelete} disabled={deleting}>
              {deleting ? "Deleting..." : "Delete Row"}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="row-builder-batch-delete" onClick={() => setConfirming(true)}>
          Delete Row
        </button>
      )}
    </div>
  );
}
