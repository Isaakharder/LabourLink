import { FormEvent, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import { EMPLOYMENT_TYPES, EmploymentPeriod, WORK_GROUPS } from "../../lib/employmentPeriodTypes";

interface EmploymentPeriodModalProps {
  employeeId: string;
  employeeName: string;
  period: EmploymentPeriod | null; // null = add a new period
  readOnly: boolean; // Manager viewer — no inputs, no save/delete
  onClose: () => void;
  onSaved: () => void;
}

interface FormState {
  startDate: string;
  expectedFinishDate: string;
  actualFinishDate: string;
  employmentType: string;
  workGroup: string;
  workGroupOtherDescription: string;
  notes: string;
}

function toFormState(period: EmploymentPeriod | null): FormState {
  return {
    startDate: period?.startDate ?? "",
    expectedFinishDate: period?.expectedFinishDate ?? "",
    actualFinishDate: period?.actualFinishDate ?? "",
    employmentType: period?.employmentType ?? "",
    workGroup: period?.workGroup ?? "",
    workGroupOtherDescription: period?.workGroupOtherDescription ?? "",
    notes: period?.notes ?? "",
  };
}

// One form serving all three entry modes the brief describes — Add,
// Edit-dates/extend (just editing expectedFinishDate forward), and Record
// actual finish (just filling in actualFinishDate) — since they're all the
// same set of fields hitting the same POST/PATCH endpoint; the user's
// intent decides which fields they actually touch, not a separate mode
// switch in this component.
export function EmploymentPeriodModal({ employeeId, employeeName, period, readOnly, onClose, onSaved }: EmploymentPeriodModalProps) {
  const [form, setForm] = useState<FormState>(toFormState(period));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setErrors({});
    setError(null);

    const body = {
      employeeId,
      startDate: form.startDate,
      expectedFinishDate: form.expectedFinishDate || null,
      actualFinishDate: form.actualFinishDate || null,
      employmentType: form.employmentType || null,
      workGroup: form.workGroup || null,
      workGroupOtherDescription: form.workGroupOtherDescription || null,
      notes: form.notes || null,
    };

    setSaving(true);
    try {
      if (period) {
        await api(`/api/employment-periods/${period.id}`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        await api("/api/employment-periods", { method: "POST", body: JSON.stringify(body) });
      }
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.errors) {
        setErrors(err.errors);
      } else {
        setError(err instanceof ApiError ? err.message : "Could not save employment period");
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!period || !deleteReason.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/api/employment-periods/${period.id}`, { method: "DELETE", body: JSON.stringify({ reason: deleteReason.trim() }) });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete employment period");
    } finally {
      setSaving(false);
    }
  }

  const title = readOnly ? `${employeeName} — Employment period` : period ? `Edit employment period — ${employeeName}` : `Add employment period — ${employeeName}`;

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        !readOnly && (
          <div className="employment-period-modal-footer">
            {period && (
              <button type="button" className="danger-button" onClick={() => setShowDeleteConfirm(true)} disabled={saving}>
                Delete period
              </button>
            )}
            <button type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" form="employment-period-form" disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        )
      }
    >
      {!readOnly && (
        <p className="employment-period-modal-note">
          Recording a finish date here does not deactivate this employee, clock them out, or change payroll/time entries. Deactivation is a
          separate, explicit action on the Directory tab.
        </p>
      )}

      {error && <p className="error-text">{error}</p>}

      <form id="employment-period-form" onSubmit={handleSubmit} className="employment-period-form">
        <label>
          Start date *
          <input type="date" value={form.startDate} onChange={(e) => set("startDate", e.target.value)} disabled={readOnly} required />
          {errors.startDate && <span className="field-error">{errors.startDate}</span>}
        </label>

        <label>
          Expected finish date
          <input type="date" value={form.expectedFinishDate} onChange={(e) => set("expectedFinishDate", e.target.value)} disabled={readOnly} />
          {errors.expectedFinishDate && <span className="field-error">{errors.expectedFinishDate}</span>}
        </label>

        <label>
          Actual finish date
          <input type="date" value={form.actualFinishDate} onChange={(e) => set("actualFinishDate", e.target.value)} disabled={readOnly} />
          {errors.actualFinishDate && <span className="field-error">{errors.actualFinishDate}</span>}
        </label>

        <label>
          Employment type
          <select value={form.employmentType} onChange={(e) => set("employmentType", e.target.value)} disabled={readOnly}>
            <option value="">Unspecified</option>
            {EMPLOYMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          {errors.employmentType && <span className="field-error">{errors.employmentType}</span>}
        </label>

        <label>
          Work group
          <select value={form.workGroup} onChange={(e) => set("workGroup", e.target.value)} disabled={readOnly}>
            <option value="">Unspecified</option>
            {WORK_GROUPS.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
          {errors.workGroup && <span className="field-error">{errors.workGroup}</span>}
        </label>

        {form.workGroup === "Other" && (
          <label>
            Work group description
            <input
              type="text"
              value={form.workGroupOtherDescription}
              onChange={(e) => set("workGroupOtherDescription", e.target.value)}
              disabled={readOnly}
            />
            {errors.workGroupOtherDescription && <span className="field-error">{errors.workGroupOtherDescription}</span>}
          </label>
        )}

        <label>
          Notes
          <textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} disabled={readOnly} rows={3} />
        </label>
      </form>

      {showDeleteConfirm && (
        <div className="employment-period-delete-confirm">
          <label>
            Reason for deleting this period *
            <input type="text" value={deleteReason} onChange={(e) => setDeleteReason(e.target.value)} autoFocus />
          </label>
          <div className="employment-period-delete-confirm-actions">
            <button type="button" onClick={() => setShowDeleteConfirm(false)} disabled={saving}>
              Cancel
            </button>
            <button type="button" className="danger-button" onClick={handleDelete} disabled={saving || !deleteReason.trim()}>
              {saving ? "Deleting..." : "Confirm delete"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
