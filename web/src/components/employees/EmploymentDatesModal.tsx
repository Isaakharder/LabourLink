import { FormEvent, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import { DATE_FIELD_LABELS, EmploymentTimelineEmployee } from "../../lib/employmentPeriodTypes";

interface EmploymentDatesModalProps {
  employee: EmploymentTimelineEmployee;
  readOnly: boolean; // Manager viewer — values shown, nothing editable
  onClose: () => void;
  onSaved: () => void;
}

interface FormState {
  startDate: string;
  workPermitExpiryDate: string;
  endDifferentDate: string;
}

// Same rule the server enforces on every save path (employees.ts's
// endingDateErrors) — checked here first so the message shows instantly.
export function validateEmploymentDates(form: FormState): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!form.startDate) errors.startDate = `${DATE_FIELD_LABELS.startDate} is required`;
  if (form.startDate && form.endDifferentDate && form.endDifferentDate < form.startDate) {
    errors.employmentEndDate = `${DATE_FIELD_LABELS.endDifferentDate} can't be earlier than the ${DATE_FIELD_LABELS.startDate}`;
  }
  if (form.startDate && form.workPermitExpiryDate && form.workPermitExpiryDate < form.startDate) {
    errors.workPermitExpiryDate = `${DATE_FIELD_LABELS.workPermitExpiryDate} can't be earlier than the ${DATE_FIELD_LABELS.startDate}`;
  }
  return errors;
}

// The timeline bar's editor: exactly the employee's three employment dates,
// saved to the same employee record the Employees Directory shows (PATCH
// /api/employees/:id — one source of truth, Administrator-only as before).
// Only these three fields are sent, so saving never changes the employee's
// active status, clocks them out, or touches time entries or payroll.
export function EmploymentDatesModal({ employee, readOnly, onClose, onSaved }: EmploymentDatesModalProps) {
  const name = `${employee.firstName} ${employee.lastName}`;
  const [form, setForm] = useState<FormState>({
    startDate: employee.employmentStartDate ?? "",
    workPermitExpiryDate: employee.workPermitExpiryDate ?? "",
    endDifferentDate: employee.endDifferentDate ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setError(null);
    const clientErrors = validateEmploymentDates(form);
    setErrors(clientErrors);
    if (Object.keys(clientErrors).length) return;

    setSaving(true);
    try {
      await api(`/api/employees/${employee.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          startDate: form.startDate,
          workPermitExpiryDate: form.workPermitExpiryDate || null,
          employmentEndDate: form.endDifferentDate || null,
        }),
      });
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.errors) setErrors(err.errors);
      else setError(err instanceof ApiError ? err.message : "Could not save the employment dates");
      setSaving(false);
    }
  }

  return (
    <Modal
      title={readOnly ? `${name} — Employment dates` : `Employment dates — ${name}`}
      onClose={onClose}
      footer={
        !readOnly && (
          <div className="employment-period-modal-footer">
            <button type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" form="employment-dates-form" className="employee-form-save" disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        )
      }
    >
      {error && <p className="error-text">{error}</p>}

      <form id="employment-dates-form" onSubmit={handleSubmit} className="employment-period-form" noValidate>
        <label>
          {DATE_FIELD_LABELS.startDate} *
          <input type="date" value={form.startDate} onChange={(e) => set("startDate", e.target.value)} disabled={readOnly} required />
          {errors.startDate && <span className="field-error">{errors.startDate}</span>}
        </label>

        <label>
          {DATE_FIELD_LABELS.workPermitExpiryDate}
          <input
            type="date"
            value={form.workPermitExpiryDate}
            onChange={(e) => set("workPermitExpiryDate", e.target.value)}
            disabled={readOnly}
          />
          {errors.workPermitExpiryDate && <span className="field-error">{errors.workPermitExpiryDate}</span>}
        </label>

        <label>
          <span>
            {DATE_FIELD_LABELS.endDifferentDate} <span className="employment-dates-optional">(optional)</span>
          </span>
          <input type="date" value={form.endDifferentDate} onChange={(e) => set("endDifferentDate", e.target.value)} disabled={readOnly} />
          <span className="field-hint">
            Only if they actually stopped working on a different day than their permit expiry. It doesn't change the permit expiry.
          </span>
          {errors.employmentEndDate && <span className="field-error">{errors.employmentEndDate}</span>}
        </label>
      </form>

      <p className="employment-period-modal-note">
        The bar ends on the {DATE_FIELD_LABELS.endDifferentDate} when entered, otherwise on the {DATE_FIELD_LABELS.workPermitExpiryDate}, otherwise it
        continues. These are the same dates as on the Employees Directory. Saving doesn't deactivate the employee, clock them out, or change time
        entries or payroll.
      </p>
    </Modal>
  );
}
