import { FormEvent, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import { GreenhouseLand } from "../../lib/greenhouseLayoutTypes";

interface LandFormModalProps {
  land: GreenhouseLand | null; // null = create mode
  onClose: () => void;
  onSaved: () => void;
}

export function LandFormModal({ land, onClose, onSaved }: LandFormModalProps) {
  const isEdit = Boolean(land);
  const [name, setName] = useState(land?.name ?? "");
  const [northSouthFeet, setNorthSouthFeet] = useState(land ? String(land.northSouthFeet) : "");
  const [eastWestFeet, setEastWestFeet] = useState(land ? String(land.eastWestFeet) : "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "Land name is required";
    const ns = Number(northSouthFeet);
    if (!northSouthFeet || !Number.isFinite(ns) || ns <= 0) next.northSouthFeet = "Enter a number greater than 0";
    const ew = Number(eastWestFeet);
    if (!eastWestFeet || !Number.isFinite(ew) || ew <= 0) next.eastWestFeet = "Enter a number greater than 0";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  const dimensionsChanged =
    isEdit && land && (Number(northSouthFeet) !== land.northSouthFeet || Number(eastWestFeet) !== land.eastWestFeet);
  const willRescale = Boolean(dimensionsChanged && land!.phases.length > 0);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitError(null);
    if (!validate()) return;

    if (willRescale) {
      const proceed = window.confirm(
        `This land has ${land!.phases.length} phase${
          land!.phases.length === 1 ? "" : "s"
        }. Resizing will proportionally rescale every phase's size and position to fit the new dimensions. Continue?`
      );
      if (!proceed) return;
    }

    setSubmitting(true);
    try {
      const payload = {
        name: name.trim(),
        northSouthFeet: Number(northSouthFeet),
        eastWestFeet: Number(eastWestFeet),
      };
      if (isEdit) {
        await api(`/api/greenhouse-layout/lands/${land!.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await api("/api/greenhouse-layout/lands", { method: "POST", body: JSON.stringify(payload) });
      }
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.errors) setErrors(err.errors);
      else if (err instanceof ApiError) setSubmitError(err.message);
      else setSubmitError("Could not save land");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={isEdit ? "Edit Land" : "Create Land"} onClose={onClose}>
      <form onSubmit={handleSubmit} className="greenhouse-simple-form" noValidate>
        {submitError && <p className="error-text">{submitError}</p>}

        <label>
          Land name *
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Main Greenhouse Property"
            required
          />
          {errors.name && <span className="field-error">{errors.name}</span>}
        </label>

        <label>
          North–South length (ft) *
          <input
            type="number"
            min="0"
            step="any"
            value={northSouthFeet}
            onChange={(e) => setNorthSouthFeet(e.target.value)}
            required
          />
          {errors.northSouthFeet && <span className="field-error">{errors.northSouthFeet}</span>}
        </label>

        <label>
          East–West width (ft) *
          <input
            type="number"
            min="0"
            step="any"
            value={eastWestFeet}
            onChange={(e) => setEastWestFeet(e.target.value)}
            required
          />
          {errors.eastWestFeet && <span className="field-error">{errors.eastWestFeet}</span>}
        </label>

        {willRescale && (
          <p className="form-warning">
            This land has existing phases. Changing dimensions will proportionally rescale every phase's size and
            position to fit the new dimensions.
          </p>
        )}

        <div className="employee-form-actions">
          <button type="button" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="employee-form-save" disabled={submitting}>
            {submitting ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
