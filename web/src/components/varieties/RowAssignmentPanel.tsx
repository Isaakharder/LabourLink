import { useMemo, useState } from "react";
import { api, ApiError } from "../../lib/api";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { GrowingSeason, SeasonRow, Variety } from "../../lib/varietyTypes";

interface Props {
  season: GrowingSeason;
  rows: SeasonRow[];
  varieties: Variety[];
  colors: Map<string, string>;
  canEdit: boolean;
  onRowsChanged: (rows: SeasonRow[]) => void;
}

interface PendingChange {
  rowIds: string[];
  varietyId: string | null;
  message: string;
}

// Assign greenhouse rows to varieties for one season. Rows are picked per
// phase by tapping them, or a consecutive range at once ("Rows 1 to 120");
// no shift-click needed, so it works the same on a tablet.
export function RowAssignmentPanel({ season, rows, varieties, colors, canEdit, onRowsChanged }: Props) {
  const liveRows = useMemo(() => rows.filter((r) => !r.deleted), [rows]);
  const phases = useMemo(() => {
    const seen = new Map<string, { id: string; label: string }>();
    for (const r of liveRows) if (!seen.has(r.phaseId)) seen.set(r.phaseId, { id: r.phaseId, label: `${r.landName} · ${r.phaseName}` });
    return [...seen.values()];
  }, [liveRows]);

  const [phaseId, setPhaseId] = useState<string>(phases[0]?.id ?? "");
  const activePhaseId = phases.some((p) => p.id === phaseId) ? phaseId : phases[0]?.id ?? "";
  const phaseRows = useMemo(() => liveRows.filter((r) => r.phaseId === activePhaseId), [liveRows, activePhaseId]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const activeVarieties = varieties.filter((v) => v.isActive);
  const [targetId, setTargetId] = useState<string>("");
  const target = activeVarieties.find((v) => v.id === targetId) ?? activeVarieties[0] ?? null;
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rangeError, setRangeError] = useState<string | null>(null);

  const varietyName = (id: string | null) => varieties.find((v) => v.id === id)?.name ?? "Unassigned";
  const selectedInPhase = phaseRows.filter((r) => selected.has(r.id));
  const unassignedCount = phaseRows.filter((r) => !r.varietyId).length;

  function changePhase(id: string) {
    setPhaseId(id);
    setSelected(new Set());
    setFrom("");
    setTo("");
    setRangeError(null);
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectRange() {
    const a = Number(from);
    const b = Number(to || from);
    if (!Number.isInteger(a) || !Number.isInteger(b) || from.trim() === "") {
      setRangeError("Enter row numbers");
      return;
    }
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const inRange = phaseRows.filter((r) => r.rowNumber >= lo && r.rowNumber <= hi);
    if (inRange.length === 0) {
      setRangeError(`No rows ${lo}–${hi} in this phase`);
      return;
    }
    setRangeError(null);
    setSelected((prev) => new Set([...prev, ...inRange.map((r) => r.id)]));
  }

  function requestChange(varietyId: string | null) {
    const chosen = selectedInPhase;
    if (chosen.length === 0) return;
    const others = chosen.filter((r) => r.varietyId && r.varietyId !== varietyId);
    if (others.length === 0) {
      void apply({ rowIds: chosen.map((r) => r.id), varietyId, message: "" });
      return;
    }
    const names = [...new Set(others.map((r) => varietyName(r.varietyId)))].join(", ");
    setPending({
      rowIds: chosen.map((r) => r.id),
      varietyId,
      message: varietyId
        ? `${others.length} of the ${chosen.length} selected rows are assigned to ${names} in ${season.name}. Reassign them to ${varietyName(varietyId)}?`
        : `Unassign ${others.length} row${others.length === 1 ? "" : "s"} from ${names} in ${season.name}?`,
    });
  }

  async function apply(change: PendingChange) {
    setSaving(true);
    setError(null);
    try {
      const res = await api<{ rows: SeasonRow[] }>(`/api/varieties/seasons/${season.id}/rows`, {
        method: "PUT",
        body: JSON.stringify({ rowIds: change.rowIds, varietyId: change.varietyId }),
      });
      onRowsChanged(res.rows);
      setSelected(new Set());
      setPending(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the row assignment");
    } finally {
      setSaving(false);
    }
  }

  if (phases.length === 0) {
    return (
      <section className="variety-assign">
        <h3>Rows</h3>
        <p className="placeholder-page">No greenhouse rows yet. Add rows in Basic Data → Rows first.</p>
      </section>
    );
  }

  return (
    <section className="variety-assign" aria-label={`Row assignments for ${season.name}`}>
      <div className="variety-assign-header">
        <h3>Rows in {season.name}</h3>
        <label className="variety-field">
          <span>Phase</span>
          <select value={activePhaseId} onChange={(e) => changePhase(e.target.value)}>
            {phases.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <span className="variety-assign-count">
          {phaseRows.length} rows · {unassignedCount} unassigned
        </span>
      </div>

      {canEdit && (
        <div className="variety-assign-tools">
          <div className="variety-range" role="group" aria-label="Select a range of rows">
            <label className="variety-field">
              <span>Rows</span>
              <input inputMode="numeric" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="from" aria-label="From row" />
            </label>
            <label className="variety-field">
              <span>to</span>
              <input inputMode="numeric" value={to} onChange={(e) => setTo(e.target.value)} placeholder="to" aria-label="To row" />
            </label>
            <button type="button" className="variety-secondary-button" onClick={selectRange}>
              Select range
            </button>
            <button type="button" className="variety-link-button" onClick={() => setSelected(new Set(phaseRows.map((r) => r.id)))}>
              Select all
            </button>
            <button type="button" className="variety-link-button" onClick={() => setSelected(new Set())} disabled={selectedInPhase.length === 0}>
              Clear selection
            </button>
          </div>
          {rangeError && <span className="field-error">{rangeError}</span>}
        </div>
      )}

      <div className="variety-legend-chips">
        {varieties
          .filter((v) => phaseRows.some((r) => r.varietyId === v.id))
          .map((v) => (
            <span key={v.id} className="variety-legend-chip">
              <span className="variety-swatch" style={{ background: colors.get(v.id) }} />
              {v.name}
            </span>
          ))}
        <span className="variety-legend-chip">
          <span className="variety-swatch variety-swatch-empty" />
          Unassigned
        </span>
      </div>

      <div className="variety-row-grid" role={canEdit ? "group" : undefined} aria-label="Rows">
        {phaseRows.map((r) => {
          const color = r.varietyId ? colors.get(r.varietyId) : undefined;
          const label = `Row ${r.rowNumber}: ${varietyName(r.varietyId)}`;
          const style = color ? { borderColor: color, background: `color-mix(in srgb, ${color} 16%, var(--color-surface))` } : undefined;
          return canEdit ? (
            <button
              key={r.id}
              type="button"
              className={`variety-row-chip${selected.has(r.id) ? " is-selected" : ""}${color ? "" : " is-unassigned"}`}
              style={style}
              aria-pressed={selected.has(r.id)}
              aria-label={label}
              title={label}
              onClick={() => toggle(r.id)}
            >
              {r.rowNumber}
            </button>
          ) : (
            <span key={r.id} className={`variety-row-chip${color ? "" : " is-unassigned"}`} style={style} title={label} aria-label={label}>
              {r.rowNumber}
            </span>
          );
        })}
      </div>

      {canEdit && (
        <div className="variety-assign-bar" aria-live="polite">
          <span className="variety-assign-selected">
            {selectedInPhase.length} row{selectedInPhase.length === 1 ? "" : "s"} selected
          </span>
          {activeVarieties.length === 0 ? (
            <span className="field-hint">Add a variety to assign rows.</span>
          ) : (
            <>
              <label className="variety-field">
                <span>Assign to</span>
                <select value={target?.id ?? ""} onChange={(e) => setTargetId(e.target.value)}>
                  {activeVarieties.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="employees-add-button" disabled={saving || selectedInPhase.length === 0 || !target} onClick={() => target && requestChange(target.id)}>
                {saving ? "Saving..." : "Assign"}
              </button>
            </>
          )}
          <button
            type="button"
            className="variety-secondary-button"
            disabled={saving || !selectedInPhase.some((r) => r.varietyId)}
            onClick={() => requestChange(null)}
          >
            Unassign
          </button>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}

      {pending && (
        <ConfirmDialog
          title={pending.varietyId ? "Reassign rows?" : "Unassign rows?"}
          message={pending.message}
          confirmLabel={pending.varietyId ? "Reassign" : "Unassign"}
          confirmingLabel="Saving..."
          submitting={saving}
          error={error}
          onConfirm={() => apply(pending)}
          onCancel={() => !saving && setPending(null)}
        />
      )}
    </section>
  );
}
