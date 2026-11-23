import { useCallback, useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import { formatNumber, GrowingSeason } from "../../lib/varietyTypes";

interface Preview {
  season: { id: string; name: string };
  affectedRows: number;
  examples: { phaseName: string; rowNumber: number; savedLengthM: number; layoutLengthM: number }[];
}

interface Props {
  season: GrowingSeason;
  onClose: () => void;
  onUpdated: () => void;
}

// "Use current layout lengths" (Administrator). Shows, from the server,
// exactly which season and how many rows would change, and needs an
// explicit tick naming both before the update is sent. The server repeats
// the check and refuses if the season or the count has changed since.
export function UseLayoutLengthsModal({ season, onClose, onUpdated }: Props) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPreview = useCallback(async () => {
    setConfirmed(false);
    try {
      setPreview(await api<Preview>(`/api/varieties/seasons/${season.id}/layout-length-changes`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not check the row lengths");
    }
  }, [season.id]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  async function update() {
    if (!preview || !confirmed) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/api/varieties/seasons/${season.id}/use-layout-lengths`, {
        method: "POST",
        body: JSON.stringify({ confirmSeasonName: preview.season.name, confirmAffectedRows: preview.affectedRows }),
      });
      onUpdated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update the saved row lengths");
      // The season or the rows changed since the preview: show the new
      // figures and ask again.
      if (err instanceof ApiError && err.status === 409) await loadPreview();
    } finally {
      setSaving(false);
    }
  }

  const n = preview?.affectedRows ?? 0;
  const rowsLabel = `${formatNumber(n, 0)} row${n === 1 ? "" : "s"}`;
  const name = preview?.season.name ?? season.name;

  return (
    <Modal title={`Update saved row lengths · ${name}`} onClose={() => !saving && onClose()} wide>
      {!preview ? (
        error ? <p className="error-text">{error}</p> : <p>Checking row lengths...</p>
      ) : n === 0 ? (
        <>
          <p>Every row in {name} already matches the current greenhouse layout. Nothing to update.</p>
          <div className="employee-form-actions">
            <button type="button" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      ) : (
        <div className="variety-lengths-confirm">
          <p>
            This replaces the saved lengths of <strong>{rowsLabel}</strong> in <strong>{name}</strong> with the current greenhouse layout. {name}'s
            total row length, plants per metre and plant estimates will change. Rows removed from the layout keep their saved length.
          </p>
          <p className="field-hint">Only do this to correct rows that were drawn the wrong length. Other seasons are not affected.</p>
          <table className="employees-table variety-rows-table variety-lengths-table">
            <thead>
              <tr>
                <th>Phase</th>
                <th>Row</th>
                <th className="num">Saved length</th>
                <th className="num">Layout now</th>
              </tr>
            </thead>
            <tbody>
              {preview.examples.map((e) => (
                <tr key={`${e.phaseName}-${e.rowNumber}`}>
                  <td>{e.phaseName}</td>
                  <td>{e.rowNumber}</td>
                  <td className="num">{formatNumber(e.savedLengthM, 1)} m</td>
                  <td className="num">{formatNumber(e.layoutLengthM, 1)} m</td>
                </tr>
              ))}
            </tbody>
          </table>
          {n > preview.examples.length && <p className="field-hint">and {formatNumber(n - preview.examples.length, 0)} more</p>}
          <label className="employee-form-checkbox variety-lengths-check">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={saving} />
            I confirm updating {rowsLabel} in {name}
          </label>
          {error && <p className="error-text">{error}</p>}
          <div className="employee-form-actions">
            <button type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="button" className="employee-form-save" onClick={update} disabled={!confirmed || saving}>
              {saving ? "Updating..." : `Update ${rowsLabel}`}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
