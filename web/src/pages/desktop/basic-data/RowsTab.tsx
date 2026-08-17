import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../../lib/api";
import { GreenhouseRowListItem, GreenhouseLandListItem, GreenhouseLand } from "../../../lib/greenhouseLayoutTypes";

type StatusFilter = "active" | "inactive" | "all";

const SIDE_LABELS: Record<string, string> = { north: "North", south: "South", east: "East", west: "West" };

function sideSummary(row: GreenhouseRowListItem): string {
  if (!row.startSide || !row.anchorSide) return "—";
  return `${SIDE_LABELS[row.startSide]} → ${SIDE_LABELS[row.anchorSide]}`;
}

// Stored row dimensions are in feet (see rowLayout.ts/greenhouseLayout.ts)
// — 1 sq ft = 0.3048^2 sq m exactly.
const SQFT_TO_SQM = 0.09290304;

function areaM2(row: GreenhouseRowListItem): string {
  return (row.widthFt * row.lengthFt * SQFT_TO_SQM).toFixed(1);
}

export function RowsTab() {
  const [rows, setRows] = useState<GreenhouseRowListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [phaseId, setPhaseId] = useState("");
  const [phaseOptions, setPhaseOptions] = useState<{ id: string; name: string }[]>([]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmingRestoreId, setConfirmingRestoreId] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    params.set("status", status);
    if (phaseId) params.set("phaseId", phaseId);

    api<{ rows: GreenhouseRowListItem[] }>(`/api/greenhouse-layout/rows?${params.toString()}`)
      .then((res) => {
        setRows(res.rows);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "Could not load rows");
      });
  }, [search, status, phaseId]);

  useEffect(() => {
    const t = window.setTimeout(load, search ? 300 : 0);
    return () => window.clearTimeout(t);
  }, [load, search]);

  // Phase filter options come from every land's phases, not from the
  // (possibly already phase-filtered or empty) rows list — otherwise
  // picking a phase with no rows yet would make the dropdown itself
  // disappear.
  useEffect(() => {
    api<{ lands: GreenhouseLandListItem[] }>("/api/greenhouse-layout/lands")
      .then(async (res) => {
        const details = await Promise.all(
          res.lands.map((l) => api<{ land: GreenhouseLand }>(`/api/greenhouse-layout/lands/${l.id}`))
        );
        const phases = details.flatMap((d) => d.land.phases.map((p) => ({ id: p.id, name: p.name })));
        setPhaseOptions(phases);
      })
      .catch(() => setPhaseOptions([]));
  }, []);

  async function handleDelete(id: string) {
    setDeletingId(id);
    setActionError(null);
    setActionMessage(null);
    try {
      await api(`/api/greenhouse-layout/rows/${id}`, { method: "DELETE" });
      setConfirmingDeleteId(null);
      if (selectedId === id) setSelectedId(null);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not delete this row");
    } finally {
      setDeletingId(null);
    }
  }

  // Distinguishing summary for a row that might share its number with
  // another inactive record in the same phase (only the database id, never
  // phase+rowNumber, ever identifies which one gets restored — see the
  // confirmation step below) — used both in that confirmation and in the
  // success message afterward, so what the admin confirmed is exactly what
  // they're told got restored.
  function rowSummary(row: GreenhouseRowListItem): string {
    const position = `${Math.round(row.xFt * 10) / 10} ft east, ${Math.round(row.yFt * 10) / 10} ft south`;
    return `${row.widthFt} ft × ${row.lengthFt} ft · ${row.batchName ?? "no batch"} · ${position} of phase NW corner`;
  }

  // Restores this exact row record (by database id) at its own already-
  // stored position — not a re-add through the row builder, which has no
  // way to target a specific historical slot (see greenhouseLayout.ts's
  // POST /rows/:id/restore for why that distinction matters). Takes the
  // full row object, captured at the moment the admin confirmed, purely so
  // the success message can describe what was restored without depending
  // on it still being in the (now stale, about-to-be-refetched) list.
  async function handleRestore(row: GreenhouseRowListItem) {
    setRestoringId(row.id);
    setActionError(null);
    setActionMessage(null);
    try {
      await api(`/api/greenhouse-layout/rows/${row.id}/restore`, { method: "POST" });
      setConfirmingRestoreId(null);
      setActionMessage(`Restored row ${row.rowNumber} — ${rowSummary(row)}.`);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not restore this row");
    } finally {
      setRestoringId(null);
    }
  }

  const selectedRow = rows?.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="rows-tab-workspace">
      <div className="rows-tab-filters">
        <input
          type="search"
          placeholder="Search row number or phase"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select value={phaseId} onChange={(e) => setPhaseId(e.target.value)}>
          <option value="">All phases</option>
          {phaseOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="all">All</option>
        </select>
      </div>

      {error && <p className="error-text">{error}</p>}
      {actionError && <p className="error-text">{actionError}</p>}
      {actionMessage && <p className="success-text">{actionMessage}</p>}

      <div className="rows-tab-body">
        {!rows ? (
          <p className="placeholder-page">Loading...</p>
        ) : rows.length === 0 ? (
          <p className="placeholder-page">No greenhouse rows found.</p>
        ) : (
          <table className="employees-table rows-tab-table">
            <thead>
              <tr>
                <th>Row #</th>
                <th>Phase</th>
                <th>Width</th>
                <th>Length</th>
                <th>Area (m²)</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className={r.id === selectedId ? "rows-tab-row-selected" : ""}
                  onClick={() => setSelectedId(r.id === selectedId ? null : r.id)}
                >
                  <td>{r.rowNumber}</td>
                  <td>{r.phaseName}</td>
                  <td>{r.widthFt} ft</td>
                  <td>{r.lengthFt} ft</td>
                  <td>{areaM2(r)} m²</td>
                  <td>
                    <span className={`status-pill ${r.isActive ? "status-active" : "status-inactive"}`}>
                      {r.isActive ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {r.isActive ? (
                      confirmingDeleteId === r.id ? (
                        <span className="rows-tab-confirm">
                          <button type="button" onClick={() => handleDelete(r.id)} disabled={deletingId === r.id}>
                            {deletingId === r.id ? "Deleting..." : "Confirm"}
                          </button>
                          <button type="button" onClick={() => setConfirmingDeleteId(null)} disabled={deletingId === r.id}>
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button type="button" className="row-builder-batch-delete" onClick={() => setConfirmingDeleteId(r.id)}>
                          Delete
                        </button>
                      )
                    ) : confirmingRestoreId === r.id ? (
                      <span className="rows-tab-confirm rows-tab-confirm-restore">
                        <span className="rows-tab-confirm-detail">{rowSummary(r)}</span>
                        <button type="button" onClick={() => handleRestore(r)} disabled={restoringId === r.id}>
                          {restoringId === r.id ? "Restoring..." : "Confirm restore"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmingRestoreId(null)}
                          disabled={restoringId === r.id}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button type="button" onClick={() => setConfirmingRestoreId(r.id)}>
                        Restore
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {selectedRow && (
          <div className="rows-tab-details">
            <h4>Row {selectedRow.rowNumber}</h4>
            <dl className="row-details-list">
              <dt>Phase</dt>
              <dd>{selectedRow.phaseName}</dd>
              <dt>Side / anchor</dt>
              <dd>{sideSummary(selectedRow)}</dd>
              <dt>Orientation</dt>
              <dd>{selectedRow.orientation}</dd>
              <dt>Width × Length</dt>
              <dd>
                {selectedRow.widthFt} ft × {selectedRow.lengthFt} ft
              </dd>
              <dt>Position in phase</dt>
              <dd>
                {Math.round(selectedRow.xFt * 10) / 10} ft east, {Math.round(selectedRow.yFt * 10) / 10} ft south of
                phase NW corner
              </dd>
              <dt>Created</dt>
              <dd>{new Date(selectedRow.createdAt).toLocaleString()}</dd>
              <dt>Updated</dt>
              <dd>{new Date(selectedRow.updatedAt).toLocaleString()}</dd>
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}
