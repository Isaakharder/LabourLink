import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../../../lib/api";
import { useAuth } from "../../../context/AuthContext";
import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import { VarietyFormModal } from "../../../components/varieties/VarietyFormModal";
import { SeasonFormModal } from "../../../components/varieties/SeasonFormModal";
import { VarietyRowsModal } from "../../../components/varieties/VarietyRowsModal";
import { RowAssignmentPanel } from "../../../components/varieties/RowAssignmentPanel";
import { formatNumber, formatSeasonDates, GrowingSeason, SeasonRow, Variety, VARIETY_COLORS } from "../../../lib/varietyTypes";

// Basic Data -> Varieties: the variety list, plants planted per variety in
// a growing season, which rows each variety is planted in, and the
// calculated density. The groundwork for harvest forecasting; no forecast
// here. Administrators edit, Managers can view.
export function VarietiesTab() {
  const { employee } = useAuth();
  const isAdmin = employee?.securityRole === "Administrator";

  const [seasons, setSeasons] = useState<GrowingSeason[] | null>(null);
  const [seasonId, setSeasonId] = useState<string | null>(null);
  const [varieties, setVarieties] = useState<Variety[] | null>(null);
  const [rows, setRows] = useState<SeasonRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [varietyModal, setVarietyModal] = useState<Variety | "new" | null>(null);
  const [seasonModal, setSeasonModal] = useState<GrowingSeason | "new" | null>(null);
  const [rowsVariety, setRowsVariety] = useState<Variety | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Variety | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmLayoutLengths, setConfirmLayoutLengths] = useState(false);
  const [updatingLengths, setUpdatingLengths] = useState(false);
  const [lengthsError, setLengthsError] = useState<string | null>(null);

  const season = seasons?.find((s) => s.id === seasonId) ?? null;

  const loadSeasons = useCallback(async (preferId?: string) => {
    try {
      const res = await api<{ seasons: GrowingSeason[]; defaultSeasonId: string | null }>("/api/varieties/seasons");
      setSeasons(res.seasons);
      setSeasonId((cur) => preferId ?? (cur && res.seasons.some((s) => s.id === cur) ? cur : res.defaultSeasonId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load seasons");
    }
  }, []);

  const loadSeasonData = useCallback(async () => {
    try {
      const q = seasonId ? `?seasonId=${seasonId}` : "";
      const [v, r] = await Promise.all([
        api<{ varieties: Variety[] }>(`/api/varieties${q}`),
        seasonId ? api<{ rows: SeasonRow[] }>(`/api/varieties/rows?seasonId=${seasonId}`) : Promise.resolve({ rows: [] as SeasonRow[] }),
      ]);
      setVarieties(v.varieties);
      setRows(r.rows);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load varieties");
    }
  }, [seasonId]);

  useEffect(() => {
    void loadSeasons();
  }, [loadSeasons]);

  useEffect(() => {
    if (seasons) void loadSeasonData();
  }, [seasons, loadSeasonData]);

  const colors = useMemo(() => {
    const m = new Map<string, string>();
    (varieties ?? []).forEach((v, i) => m.set(v.id, VARIETY_COLORS[i % VARIETY_COLORS.length]));
    return m;
  }, [varieties]);

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api(`/api/varieties/${deleteTarget.id}`, { method: "DELETE" });
      setDeleteTarget(null);
      void loadSeasonData();
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Could not delete this variety");
    } finally {
      setDeleting(false);
    }
  }

  // Explicit, confirmed: the only way a season's saved row lengths change.
  async function useLayoutLengths() {
    if (!season) return;
    setUpdatingLengths(true);
    setLengthsError(null);
    try {
      await api(`/api/varieties/seasons/${season.id}/use-layout-lengths`, { method: "POST" });
      setConfirmLayoutLengths(false);
      void loadSeasonData();
    } catch (err) {
      setLengthsError(err instanceof ApiError ? err.message : "Could not update the saved row lengths");
    } finally {
      setUpdatingLengths(false);
    }
  }

  const changedLengthRows = (rows ?? []).filter((r) => r.varietyId && r.lengthChanged).length;
  const shown = (varieties ?? []).filter((v) => v.isActive || v.plantedThisSeason);
  const hiddenInactive = (varieties ?? []).length - shown.length;

  return (
    <section className="setup-section varieties-tab">
      <div className="variety-toolbar">
        <label className="variety-field variety-season-field">
          <span>Growing season</span>
          <select value={seasonId ?? ""} onChange={(e) => setSeasonId(e.target.value || null)} disabled={!seasons || seasons.length === 0}>
            {seasons && seasons.length === 0 && <option value="">No seasons yet</option>}
            {(seasons ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.isCurrent ? " (current)" : ""}
              </option>
            ))}
          </select>
        </label>
        {season && <span className="variety-season-dates">{formatSeasonDates(season)}</span>}
        {isAdmin && (
          <div className="variety-toolbar-actions">
            {season && (
              <button type="button" className="variety-secondary-button" onClick={() => setSeasonModal(season)}>
                Edit season
              </button>
            )}
            <button type="button" className="variety-secondary-button" onClick={() => setSeasonModal("new")}>
              New season
            </button>
            <button type="button" className="employees-add-button" onClick={() => setVarietyModal("new")}>
              Add variety
            </button>
          </div>
        )}
      </div>

      {error && <p className="error-text">{error}</p>}

      {seasons && seasons.length === 0 && (
        <p className="variety-empty">
          Create a growing season to record plants planted and which rows each variety is in. Seasons keep each year's planting and row lengths
          separate, so past harvests stay with the variety and row lengths of that season.{isAdmin ? " New season suggests 2027 Growing Season from January 1, 2027." : ""}
        </p>
      )}

      {!varieties ? (
        !error && <p>Loading...</p>
      ) : shown.length === 0 ? (
        <p className="placeholder-page">No varieties yet.{isAdmin ? " Click Add variety to create one." : ""}</p>
      ) : (
        <div className="variety-table-wrap">
          <table className="employees-table variety-table">
            <thead>
              <tr>
                <th>Variety</th>
                <th className="num">Plants planted</th>
                <th className="num">Rows</th>
                <th className="num">Row length</th>
                <th className="num">
                  Plants / m <span className="variety-calc-tag">Calculated</span>
                </th>
                <th className="num">
                  Plants / row <span className="variety-calc-tag">Calculated</span>
                </th>
                <th className="num">
                  Plants / row <span className="variety-entered-tag">Entered</span>
                </th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((v) => {
                const s = v.summary;
                const enteredAvg = s.rowsWithEnteredCount ? s.enteredPlantsTotal! / s.rowsWithEnteredCount : null;
                return (
                  <tr key={v.id} className={v.isActive ? undefined : "variety-inactive"}>
                    <td>
                      <span className="variety-name">
                        <span className="variety-swatch" style={{ background: colors.get(v.id) }} />
                        {v.name}
                        {!v.isActive && <span className="variety-status-tag">Inactive</span>}
                      </span>
                      {v.notes && <span className="variety-notes">{v.notes}</span>}
                    </td>
                    <td className="num">{v.totalPlants == null ? <span className="variety-missing">Not recorded</span> : formatNumber(v.totalPlants, 0)}</td>
                    <td className="num">
                      {s.rows}
                      {s.deletedRows > 0 && <span className="variety-notes"> (incl. {s.deletedRows} removed from layout)</span>}
                    </td>
                    <td className="num">{s.rows ? `${formatNumber(s.totalLengthM, 1)} m` : "—"}</td>
                    <td className="num">{formatNumber(s.plantsPerMetre, 2)}</td>
                    <td className="num">{formatNumber(s.averageEstimatedPlantsPerRow, 1)}</td>
                    <td className="num" title={s.rowsWithEnteredCount ? `${s.rowsWithEnteredCount} of ${s.rows} rows have a Plants per row setting` : undefined}>
                      {enteredAvg == null ? "—" : formatNumber(enteredAvg, 0)}
                      {enteredAvg != null && s.rowsWithEnteredCount < s.rows && <span className="variety-notes"> ({s.rowsWithEnteredCount} rows)</span>}
                    </td>
                    <td>
                      <div className="employee-row-actions">
                        {season && (
                          <button type="button" aria-label={`Rows for ${v.name}`} onClick={() => setRowsVariety(v)} disabled={s.rows === 0}>
                            Rows
                          </button>
                        )}
                        {isAdmin && (
                          <button type="button" aria-label={`Edit ${v.name}`} onClick={() => setVarietyModal(v)}>
                            Edit
                          </button>
                        )}
                        {isAdmin && !v.inUse && (
                          <button
                            type="button"
                            onClick={() => {
                              setDeleteError(null);
                              setDeleteTarget(v);
                            }}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {varieties && (
        <p className="field-hint variety-legend">
          <strong>Calculated</strong> figures come from the plants planted and each row's length saved for this season: plants are shared across rows
          in proportion to length. Later greenhouse layout changes don't alter them. <strong>Entered</strong> is the average Plants per row setting from Basic Data → Density on these rows.
          {hiddenInactive > 0 && ` ${hiddenInactive} inactive variet${hiddenInactive === 1 ? "y" : "ies"} not planted this season hidden.`}
        </p>
      )}

      {season && changedLengthRows > 0 && (
        <div className="variety-length-notice" role="status">
          <span>
            {changedLengthRows} row{changedLengthRows === 1 ? " has" : "s have"} a different length in the current greenhouse layout than the length saved
            for {season.name}. This season's figures keep using the saved lengths.
          </span>
          {isAdmin && (
            <button
              type="button"
              className="variety-secondary-button"
              onClick={() => {
                setLengthsError(null);
                setConfirmLayoutLengths(true);
              }}
            >
              Use current layout lengths
            </button>
          )}
        </div>
      )}

      {season && rows && varieties && (
        <RowAssignmentPanel
          key={season.id}
          season={season}
          rows={rows}
          varieties={varieties}
          colors={colors}
          canEdit={isAdmin}
          onRowsChanged={(next) => {
            setRows(next);
            void loadSeasonData();
          }}
        />
      )}

      {varietyModal && (
        <VarietyFormModal
          variety={varietyModal === "new" ? null : varietyModal}
          season={season}
          onClose={() => setVarietyModal(null)}
          onSaved={() => {
            setVarietyModal(null);
            void loadSeasonData();
          }}
        />
      )}
      {seasonModal && seasons && (
        <SeasonFormModal
          season={seasonModal === "new" ? null : seasonModal}
          seasons={seasons}
          onClose={() => setSeasonModal(null)}
          onSaved={(id) => {
            setSeasonModal(null);
            void loadSeasons(id);
          }}
        />
      )}
      {rowsVariety && season && <VarietyRowsModal variety={rowsVariety} season={season} onClose={() => setRowsVariety(null)} />}
      {confirmLayoutLengths && season && (
        <ConfirmDialog
          title="Use current layout lengths?"
          message={`Replace the row lengths saved for ${season.name} with the current greenhouse layout for ${changedLengthRows} row${
            changedLengthRows === 1 ? "" : "s"
          }? This changes ${season.name}'s row lengths, plants per metre and plant estimates. Only do this to correct rows that were drawn the wrong length.`}
          confirmLabel="Use current lengths"
          confirmingLabel="Updating..."
          submitting={updatingLengths}
          error={lengthsError}
          onConfirm={useLayoutLengths}
          onCancel={() => !updatingLengths && setConfirmLayoutLengths(false)}
        />
      )}
      {deleteTarget && (
        <ConfirmDialog
          title="Delete variety?"
          message={`Delete ${deleteTarget.name}? It hasn't been planted in any season.`}
          confirmLabel="Delete"
          confirmingLabel="Deleting..."
          submitting={deleting}
          error={deleteError}
          onConfirm={confirmDelete}
          onCancel={() => !deleting && setDeleteTarget(null)}
        />
      )}
    </section>
  );
}
