import { FormEvent, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import { GrowingSeason, Variety } from "../../lib/varietyTypes";

interface Props {
  variety: Variety | null; // null = add
  season: GrowingSeason | null;
  onClose: () => void;
  onSaved: () => void;
}

// Add / edit a variety, and its plants planted in the selected season.
export function VarietyFormModal({ variety, season, onClose, onSaved }: Props) {
  const [name, setName] = useState(variety?.name ?? "");
  const [notes, setNotes] = useState(variety?.notes ?? "");
  const [isActive, setIsActive] = useState(variety?.isActive ?? true);
  const [totalPlants, setTotalPlants] = useState(variety?.totalPlants != null ? String(variety.totalPlants) : "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "Variety name is required";
    const plantsText = totalPlants.trim().replace(/,/g, "");
    if (plantsText && !/^\d+$/.test(plantsText)) next.totalPlants = "Enter a whole number of plants";
    else if (plantsText && Number(plantsText) <= 0) next.totalPlants = "Enter a number greater than 0";
    setErrors(next);
    if (Object.keys(next).length) return;

    const body: Record<string, unknown> = { name: name.trim(), notes: notes.trim() || null };
    if (variety) body.isActive = isActive;
    const plantsChanged = (plantsText ? Number(plantsText) : null) !== (variety?.totalPlants ?? null);
    if (season && plantsChanged) {
      body.seasonId = season.id;
      body.totalPlants = plantsText ? Number(plantsText) : null;
    }

    setSaving(true);
    setFormError(null);
    try {
      await api(variety ? `/api/varieties/${variety.id}` : "/api/varieties", { method: variety ? "PATCH" : "POST", body: JSON.stringify(body) });
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.errors) setErrors(err.errors);
      else setFormError(err instanceof ApiError ? err.message : "Could not save this variety");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={variety ? "Edit variety" : "Add variety"} onClose={onClose}>
      <form onSubmit={handleSubmit} className="employee-form" noValidate>
        <section className="employee-form-section">
          <div className="employee-form-grid">
            <label>
              Name *
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus disabled={saving} />
              {errors.name && <span className="field-error">{errors.name}</span>}
            </label>
            <label>
              Plants planted{season ? ` (${season.name})` : ""}
              <input
                inputMode="numeric"
                value={totalPlants}
                onChange={(e) => setTotalPlants(e.target.value)}
                placeholder={season ? "e.g. 148500" : "Create a season first"}
                disabled={saving || !season}
              />
              <span className="field-hint">The total number of plants of this variety planted this season. Per-row figures are calculated from it.</span>
              {errors.totalPlants && <span className="field-error">{errors.totalPlants}</span>}
            </label>
            <label className="variety-form-notes">
              Notes
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} disabled={saving} />
            </label>
            {variety && (
              <label className="employee-form-checkbox">
                <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} disabled={saving} />
                Active (inactive varieties keep their history but can't get new rows)
              </label>
            )}
          </div>
        </section>
        {formError && <p className="error-text">{formError}</p>}
        <div className="employee-form-actions">
          <button type="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="employee-form-save" disabled={saving}>
            {saving ? "Saving..." : variety ? "Save" : "Add variety"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
