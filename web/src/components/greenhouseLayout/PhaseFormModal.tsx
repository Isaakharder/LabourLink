import { FormEvent, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import { GreenhousePhase } from "../../lib/greenhouseLayoutTypes";

interface PhaseFormModalProps {
  landId: string;
  phase: GreenhousePhase | null; // null = create mode
  onClose: () => void;
  onSaved: () => void;
}

export function PhaseFormModal({ landId, phase, onClose, onSaved }: PhaseFormModalProps) {
  const isEdit = Boolean(phase);
  const [name, setName] = useState(phase?.name ?? "");
  const [description, setDescription] = useState(phase?.description ?? "");
  const [northSouthFeet, setNorthSouthFeet] = useState(phase ? String(phase.northSouthFeet) : "");
  const [eastWestFeet, setEastWestFeet] = useState(phase ? String(phase.eastWestFeet) : "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [offerReposition, setOfferReposition] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "Phase name is required";
    const ns = Number(northSouthFeet);
    if (!northSouthFeet || !Number.isFinite(ns) || ns <= 0) next.northSouthFeet = "Enter a number greater than 0";
    const ew = Number(eastWestFeet);
    if (!eastWestFeet || !Number.isFinite(ew) || ew <= 0) next.eastWestFeet = "Enter a number greater than 0";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function submit(reposition: boolean) {
    setSubmitting(true);
    setSubmitError(null);
    setOfferReposition(false);
    try {
      const payload: Record<string, unknown> = {
        name: name.trim(),
        description: description.trim() || null,
        northSouthFeet: Number(northSouthFeet),
        eastWestFeet: Number(eastWestFeet),
      };
      if (reposition) {
        payload.xFeetFromWest = 0;
        payload.yFeetFromNorth = 0;
      }

      if (isEdit) {
        await api(`/api/greenhouse-layout/phases/${phase!.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await api(`/api/greenhouse-layout/lands/${landId}/phases`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
      }
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && isEdit && !reposition) {
        // The new size doesn't fit at the phase's current position — offer
        // to reposition to the land's top-left corner and retry, rather
        // than silently moving it ourselves.
        setSubmitError(err.message);
        setOfferReposition(true);
      } else if (err instanceof ApiError && err.errors) {
        setErrors(err.errors);
      } else if (err instanceof ApiError) {
        setSubmitError(err.message);
      } else {
        setSubmitError("Could not save phase");
      }
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (!validate()) return;
    submit(false);
  }

  return (
    <Modal title={isEdit ? "Edit Phase" : "Create Phase"} onClose={onClose}>
      <form onSubmit={handleSubmit} className="greenhouse-simple-form" noValidate>
        {submitError && <p className="error-text">{submitError}</p>}

        <label>
          Phase name *
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Phase 1"
            required
          />
          {errors.name && <span className="field-error">{errors.name}</span>}
        </label>

        <label>
          Description
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} />
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

        {offerReposition && (
          <p className="form-warning">
            The resized phase no longer fits at its current position.{" "}
            <button type="button" onClick={() => submit(true)} disabled={submitting}>
              Reposition to top-left and retry
            </button>
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
