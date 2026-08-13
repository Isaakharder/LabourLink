import { FormEvent, useEffect, useMemo, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import { Carrier } from "../../lib/carrierTypes";
import { MAX_BULK_CARRIERS, buildBulkCarrierNames, normalizeCarrierName } from "../../lib/carrierBulk";

interface CarrierBulkAddModalProps {
  onClose: () => void;
  // Called after a successful save (createdCount > 0 or not — the server
  // call succeeding is what matters, even an all-duplicates result is a
  // "successful" bulk request) with a human-readable summary for the
  // caller to show once the modal is gone.
  onSaved: (message: string) => void;
}

interface FormState {
  prefix: string;
  startNumber: string;
  endNumber: string;
  padding: string;
  tareWeightKg: string;
  notes: string;
  isActive: boolean;
}

const DEFAULTS: FormState = {
  prefix: "Bin",
  startNumber: "1",
  endNumber: "",
  padding: "",
  tareWeightKg: "0",
  notes: "",
  isActive: true,
};

// Bulk Add's own field-level validation, mirroring
// server/src/lib/carrierBulk.ts's validateBulkCarrierRequest — the server
// re-validates authoritatively, this is only for immediate inline feedback
// and to gate the Save button before a round trip.
function validate(form: FormState): Record<string, string> {
  const errors: Record<string, string> = {};

  if (!form.prefix.trim()) errors.prefix = "Prefix is required";

  const start = Number(form.startNumber);
  const startValid = form.startNumber.trim() !== "" && Number.isInteger(start) && start >= 0;
  if (!startValid) errors.startNumber = "Start number must be a whole number of 0 or greater";

  const end = Number(form.endNumber);
  const endValid = form.endNumber.trim() !== "" && Number.isInteger(end) && end >= 0;
  if (!endValid) {
    errors.endNumber = "End number must be a whole number of 0 or greater";
  } else if (startValid && end < start) {
    errors.endNumber = "End number must be greater than or equal to the start number";
  } else if (startValid && end - start + 1 > MAX_BULK_CARRIERS) {
    errors.endNumber = `Bulk Add supports at most ${MAX_BULK_CARRIERS} carriers per batch`;
  }

  if (form.padding.trim() !== "") {
    const padding = Number(form.padding);
    if (!Number.isInteger(padding) || padding < 0 || padding > 10) {
      errors.padding = "Padding must be a whole number between 0 and 10";
    }
  }

  const tare = Number(form.tareWeightKg);
  if (form.tareWeightKg.trim() === "" || !Number.isFinite(tare) || tare < 0) {
    errors.tareWeightKg = "Tare weight must be 0 or greater";
  }

  return errors;
}

export function CarrierBulkAddModal({ onClose, onSaved }: CarrierBulkAddModalProps) {
  const [form, setForm] = useState<FormState>(DEFAULTS);
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [existingNames, setExistingNames] = useState<Set<string> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function touch(field: string) {
    setTouched((prev) => (prev.has(field) ? prev : new Set(prev).add(field)));
  }

  // Every existing carrier's normalized name, regardless of the current
  // active/inactive filter elsewhere on the page — uniqueness in the
  // database doesn't care about is_active, so the preview below shouldn't
  // either. Fetched once when the modal opens; the actual Save call is
  // re-validated authoritatively by the server regardless.
  useEffect(() => {
    api<{ carriers: Carrier[] }>("/api/carriers?status=all")
      .then((res) => setExistingNames(new Set(res.carriers.map((c) => normalizeCarrierName(c.name)))))
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Could not check for existing carrier names"));
  }, []);

  const errors = useMemo(() => validate(form), [form]);

  const candidateNames = useMemo(() => {
    if (errors.prefix || errors.startNumber || errors.endNumber || errors.padding) return [];
    const padding = form.padding.trim() === "" ? null : Number(form.padding);
    return buildBulkCarrierNames(form.prefix.trim(), Number(form.startNumber), Number(form.endNumber), padding);
  }, [form.prefix, form.startNumber, form.endNumber, form.padding, errors.prefix, errors.startNumber, errors.endNumber, errors.padding]);

  const preview = useMemo(() => {
    if (candidateNames.length === 0 || !existingNames) return null;
    const duplicateCount = candidateNames.filter((n) => existingNames.has(normalizeCarrierName(n))).length;
    return { total: candidateNames.length, duplicateCount, createCount: candidateNames.length - duplicateCount };
  }, [candidateNames, existingNames]);

  const hasErrors = Object.keys(errors).length > 0;
  const saveDisabled = submitting || hasErrors || !existingNames;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitError(null);
    if (hasErrors) {
      setTouched(new Set(["prefix", "startNumber", "endNumber", "padding", "tareWeightKg"]));
      return;
    }

    setSubmitting(true);
    try {
      const result = await api<{ createdCount: number; skippedCount: number }>("/api/carriers/bulk", {
        method: "POST",
        body: JSON.stringify({
          prefix: form.prefix.trim(),
          startNumber: Number(form.startNumber),
          endNumber: Number(form.endNumber),
          padding: form.padding.trim() === "" ? null : Number(form.padding),
          tareWeightKg: Number(form.tareWeightKg),
          notes: form.notes.trim() || null,
          isActive: form.isActive,
        }),
      });

      const { createdCount, skippedCount } = result;
      const message =
        skippedCount > 0
          ? `Created ${createdCount} carrier${createdCount === 1 ? "" : "s"}. Skipped ${skippedCount} duplicate${skippedCount === 1 ? "" : "s"}.`
          : `Created ${createdCount} carrier${createdCount === 1 ? "" : "s"}`;
      onSaved(message);
    } catch (err) {
      if (err instanceof ApiError && err.errors) {
        setSubmitError(Object.values(err.errors)[0] ?? err.message);
      } else if (err instanceof ApiError) {
        setSubmitError(err.message);
      } else {
        setSubmitError("Something went wrong creating these carriers");
      }
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Bulk Add Carriers" onClose={onClose}>
      <form onSubmit={handleSubmit} className="employee-form" noValidate>
        {loadError && <p className="error-text">{loadError}</p>}
        {submitError && <p className="error-text">{submitError}</p>}

        <section className="employee-form-section">
          <div className="employee-form-grid">
            <label>
              Prefix *
              <input
                type="text"
                value={form.prefix}
                onChange={(e) => {
                  set("prefix", e.target.value);
                  touch("prefix");
                }}
                placeholder="e.g. Bin"
                required
              />
              {touched.has("prefix") && errors.prefix && <span className="field-error">{errors.prefix}</span>}
            </label>
            <label>
              Number padding
              <input
                type="number"
                min="0"
                max="10"
                step="1"
                value={form.padding}
                onChange={(e) => {
                  set("padding", e.target.value);
                  touch("padding");
                }}
                placeholder="e.g. 3 for 001"
              />
              {touched.has("padding") && errors.padding && <span className="field-error">{errors.padding}</span>}
            </label>
            <label>
              Start number *
              <input
                type="number"
                min="0"
                step="1"
                value={form.startNumber}
                onChange={(e) => {
                  set("startNumber", e.target.value);
                  touch("startNumber");
                }}
                required
              />
              {touched.has("startNumber") && errors.startNumber && <span className="field-error">{errors.startNumber}</span>}
            </label>
            <label>
              End number *
              <input
                type="number"
                min="0"
                step="1"
                value={form.endNumber}
                onChange={(e) => {
                  set("endNumber", e.target.value);
                  touch("endNumber");
                }}
                required
              />
              {touched.has("endNumber") && errors.endNumber && <span className="field-error">{errors.endNumber}</span>}
            </label>
            <label>
              Tare weight (kg) *
              <input
                type="number"
                min="0"
                step="any"
                value={form.tareWeightKg}
                onChange={(e) => {
                  set("tareWeightKg", e.target.value);
                  touch("tareWeightKg");
                }}
                required
              />
              {touched.has("tareWeightKg") && errors.tareWeightKg && <span className="field-error">{errors.tareWeightKg}</span>}
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

          {preview && (
            <div className="row-builder-preview-stats" style={{ marginTop: "0.85rem" }}>
              <span>
                {preview.duplicateCount === 0 ? (
                  <>
                    <strong>{preview.total}</strong> carrier{preview.total === 1 ? "" : "s"} will be created
                  </>
                ) : (
                  <>
                    <strong>{preview.createCount}</strong> will be created, <strong>{preview.duplicateCount}</strong> already exist
                    and will be skipped
                  </>
                )}
              </span>
            </div>
          )}
        </section>

        <div className="employee-form-actions">
          <button type="button" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="employee-form-save" disabled={saveDisabled}>
            {submitting ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
