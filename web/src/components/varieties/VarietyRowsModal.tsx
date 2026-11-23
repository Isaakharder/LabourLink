import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import { formatNumber, GrowingSeason, Variety, VarietyRowDetail } from "../../lib/varietyTypes";

interface Props {
  variety: Variety;
  season: GrowingSeason;
  onClose: () => void;
}

// One variety's rows in a season: saved length, the CALCULATED share of
// plants planted, and the ENTERED Plant Density value where there is one.
export function VarietyRowsModal({ variety, season, onClose }: Props) {
  const [rows, setRows] = useState<VarietyRowDetail[] | null>(null);
  const [totalPlants, setTotalPlants] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ totalPlants: number | null; rows: VarietyRowDetail[] }>(`/api/varieties/${variety.id}/rows?seasonId=${season.id}`)
      .then((res) => {
        setRows(res.rows);
        setTotalPlants(res.totalPlants);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load rows"));
  }, [variety.id, season.id]);

  return (
    <Modal title={`${variety.name} · ${season.name}`} onClose={onClose} wide>
      <p className="variety-rows-intro">
        {totalPlants == null
          ? "Record plants planted for this variety to calculate plants per row."
          : `${formatNumber(totalPlants, 0)} plants planted, shared across these rows in proportion to each row's length saved for this season.`}
      </p>
      {error && <p className="error-text">{error}</p>}
      {!rows ? (
        !error && <p>Loading...</p>
      ) : rows.length === 0 ? (
        <p className="placeholder-page">No rows assigned to this variety in this season.</p>
      ) : (
        <div className="variety-rows-table-wrap">
          <table className="employees-table variety-rows-table">
            <thead>
              <tr>
                <th>Phase</th>
                <th>Row</th>
                <th className="num">Season length</th>
                <th className="num">
                  Estimated plants <span className="variety-calc-tag">Calculated</span>
                </th>
                <th className="num">
                  Plants per row <span className="variety-entered-tag">Entered</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.deleted ? "variety-row-deleted" : undefined}>
                  <td>{r.phaseName}</td>
                  <td>
                    {r.rowNumber}
                    {r.deleted && <span className="variety-deleted-tag">Removed from layout</span>}
                  </td>
                  <td className="num">
                    {formatNumber(r.lengthM, 1)} m
                    {r.lengthChanged && r.layoutLengthM != null && (
                      <span className="variety-layout-length" title="The current greenhouse layout has a different length for this row. This season keeps its saved length.">
                        layout now {formatNumber(r.layoutLengthM, 1)} m
                      </span>
                    )}
                  </td>
                  <td className="num">{r.estimatedPlants == null ? "—" : formatNumber(r.estimatedPlants, 1)}</td>
                  <td className="num">{r.enteredPlantsPerRow == null ? "—" : formatNumber(r.enteredPlantsPerRow, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="field-hint variety-legend">
        <strong>Calculated</strong>: from plants planted and the row lengths saved for this season, never counted in the row. <strong>Entered</strong>: the Plants per row setting
        from Basic Data → Density.
      </p>
    </Modal>
  );
}
