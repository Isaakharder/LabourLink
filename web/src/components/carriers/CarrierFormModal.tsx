import { FormEvent, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import { Carrier } from "../../lib/carrierTypes";
import { CarrierHistory } from "./CarrierHistory";

interface CarrierFormModalProps {
  carrier: Carrier | null; // null = create mode
  onClose: () => void;
  onSaved: () => void;
}

interface FormState {
  name: string;
  notes: string;
  tareWeightKg: string;
  rfidTag: string;
  isActive: boolean;
}

// Same normalization as the server's lib/rfidTag.ts (whitespace removed,
// uppercased) — used only to compare against the saved tag and to validate
// before submit; the server re-normalizes and is authoritative.
function normalizeRfidTag(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

function toFormState(carrier: Carrier | null): FormState {
  return {
    name: carrier?.name ?? "",
    notes: carrier?.notes ?? "",
    tareWeightKg: carrier ? String(carrier.tareWeightKg) : "0",
    rfidTag: carrier?.rfidTag ?? "",
    isActive: carrier?.isActive ?? true,
  };
}

export function CarrierFormModal({ carrier, onClose, onSaved }: CarrierFormModalProps) {
  const isEdit = Boolean(carrier);
  const [form, setForm] = useState<FormState>(() => toFormState(carrier));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!form.name.trim()) next.name = "Carrier name is required";
    const tare = Number(form.tareWeightKg);
    if (form.tareWeightKg.trim() === "" || !Number.isFinite(tare) || tare < 0) {
      next.tareWeightKg = "Tare weight must be 0 or greater";
    }
    const rfid = normalizeRfidTag(form.rfidTag);
    if (rfid && !/^[0-9A-Z]{1,64}$/.test(rfid)) {
      next.rfidTag = "RFID tag may only contain letters and digits (64 max)";
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitError(null);
    if (!validate()) return;

    // Replacing or clearing an existing assignment is never silent.
    const nextRfid = normalizeRfidTag(form.rfidTag) || null;
    const savedRfid = carrier?.rfidTag ?? null;
    if (savedRfid && nextRfid !== savedRfid) {
      const message = nextRfid
        ? `Replace RFID tag ${savedRfid} on "${carrier!.name}" with ${nextRfid}?`
        : `Remove RFID tag ${savedRfid} from "${carrier!.name}"? It will show as Not assigned.`;
      if (!window.confirm(message)) return;
    }

    setSubmitting(true);
    try {
      const payload = {
        name: form.name.trim(),
        notes: form.notes.trim() || null,
        tareWeightKg: Number(form.tareWeightKg),
        rfidTag: nextRfid,
        isActive: form.isActive,
      };

      if (isEdit) {
        await api(`/api/carriers/${carrier!.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await api("/api/carriers", { method: "POST", body: JSON.stringify(payload) });
      }
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.errors) {
        setErrors(err.errors);
      } else if (err instanceof ApiError) {
        setSubmitError(err.message);
      } else {
        setSubmitError("Something went wrong saving this carrier");
      }
      setSubmitting(false);
    }
  }

  return (
    <Modal title={isEdit ? "Edit Carrier" : "Add Carrier"} onClose={onClose}>
      <form onSubmit={handleSubmit} className="employee-form" noValidate>
        {submitError && <p className="error-text">{submitError}</p>}

        <section className="employee-form-section">
          <div className="employee-form-grid">
            <label>
              Carrier name *
              <input
                type="text"
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="e.g. Carrier 4"
                required
              />
              {errors.name && <span className="field-error">{errors.name}</span>}
            </label>
            <label>
              Tare weight (kg) *
              <input
                type="number"
                min="0"
                step="any"
                value={form.tareWeightKg}
                onChange={(e) => set("tareWeightKg", e.target.value)}
                required
              />
              {errors.tareWeightKg && <span className="field-error">{errors.tareWeightKg}</span>}
            </label>
            <label>
              RFID tag
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={form.rfidTag}
                onChange={(e) => set("rfidTag", e.target.value)}
                placeholder="Not assigned"
              />
              {errors.rfidTag && <span className="field-error">{errors.rfidTag}</span>}
            </label>
            <label>
              Notes
              <input type="text" value={form.notes} onChange={(e) => set("notes", e.target.value)} />
            </label>
            <label className="employee-form-checkbox">
              <input type="checkbox" checked={form.isActive} onChange={(e) => set("isActive", e.target.checked)} />
              Active
            </label>
          </div>
        </section>

        {carrier && <CarrierHistory carrierId={carrier.id} />}

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
