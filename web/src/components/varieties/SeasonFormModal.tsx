import { FormEvent, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import { GrowingSeason } from "../../lib/varietyTypes";

export const SUGGESTED_FIRST_SEASON = { name: "2027 Growing Season", startsOn: "2027-01-01" };

interface Props {
  season: GrowingSeason | null; // null = new season
  seasons: GrowingSeason[];
  onClose: () => void;
  onSaved: (seasonId: string) => void;
}

// New / edit growing season. Seasons can't overlap (the server checks), so
// every harvest date belongs to one season's planting. A new season can
// start as a copy of another season's plantings and row assignments. With
// no seasons yet, the form suggests "2027 Growing Season" from January 1,
// 2027 (a suggestion only; nothing is created until it's saved).
export function SeasonFormModal({ season, seasons, onClose, onSaved }: Props) {
  const latest = seasons[0];
  const suggest = !season && seasons.length === 0;
  const [name, setName] = useState(season?.name ?? (suggest ? SUGGESTED_FIRST_SEASON.name : ""));
  const [startsOn, setStartsOn] = useState(season?.startsOn ?? (suggest ? SUGGESTED_FIRST_SEASON.startsOn : ""));
  const [endsOn, setEndsOn] = useState(season?.endsOn ?? "");
  const [copyFrom, setCopyFrom] = useState<string>(season ? "" : latest?.id ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "Season name is required";
    if (!startsOn) next.startsOn = "Start date is required";
    if (startsOn && endsOn && endsOn < startsOn) next.endsOn = "End date can't be before the start date";
    setErrors(next);
    if (Object.keys(next).length) return;

    const body: Record<string, unknown> = { name: name.trim(), startsOn, endsOn: endsOn || null };
    if (!season && copyFrom) body.copyFromSeasonId = copyFrom;
    setSaving(true);
    setFormError(null);
    try {
      const res = await api<{ season: GrowingSeason }>(season ? `/api/varieties/seasons/${season.id}` : "/api/varieties/seasons", {
        method: season ? "PATCH" : "POST",
        body: JSON.stringify(body),
      });
      onSaved(res.season.id);
    } catch (err) {
      if (err instanceof ApiError && err.errors) setErrors(err.errors);
      else setFormError(err instanceof ApiError ? err.message : "Could not save this season");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={season ? "Edit season" : "New growing season"} onClose={onClose}>
      <form onSubmit={handleSubmit} className="employee-form" noValidate>
        <section className="employee-form-section">
          <div className="employee-form-grid">
            <label>
              Name *
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. 2027 season" autoFocus disabled={saving} />
              {errors.name && <span className="field-error">{errors.name}</span>}
            </label>
            <span />
            <label>
              Starts *
              <input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} disabled={saving} />
              {errors.startsOn && <span className="field-error">{errors.startsOn}</span>}
            </label>
            <label>
              Ends
              <input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} disabled={saving} />
              <span className="field-hint">Leave empty while the season is running.</span>
              {errors.endsOn && <span className="field-error">{errors.endsOn}</span>}
            </label>
            {!season && seasons.length > 0 && (
              <label className="variety-form-notes">
                Start from
                <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)} disabled={saving}>
                  <option value="">An empty season</option>
                  {seasons.map((s) => (
                    <option key={s.id} value={s.id}>
                      A copy of {s.name} (plants planted and row assignments)
                    </option>
                  ))}
                </select>
                <span className="field-hint">Copying never changes the earlier season; its rows stay linked to what was planted then.</span>
              </label>
            )}
          </div>
        </section>
        {suggest && (
          <p className="field-hint">Suggested first season. Change the name or dates as needed; an earlier season (e.g. 2026) can be added later for history.</p>
        )}
        {formError && <p className="error-text">{formError}</p>}
        <div className="employee-form-actions">
          <button type="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="employee-form-save" disabled={saving}>
            {saving ? "Saving..." : season ? "Save" : "Create season"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
