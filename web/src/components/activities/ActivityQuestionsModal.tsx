import { FormEvent, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import { Activity, QUESTION_TYPE_LABELS } from "../../lib/activityTypes";

interface ActivityQuestionsModalProps {
  activity: Activity;
  onClose: () => void;
  onSaved: () => void;
}

// v1 supports exactly one question, of exactly one type (Greenhouse Row) —
// so this is a toggle + label + required checkbox, not a generic
// form-builder. question_type is still a real field end-to-end (see
// 014_activity_questions.sql), so a second type can be added here later
// without a schema change.
export function ActivityQuestionsModal({ activity, onClose, onSaved }: ActivityQuestionsModalProps) {
  const [enabled, setEnabled] = useState(activity.question !== null);
  const [label, setLabel] = useState(activity.question?.label ?? "Where?");
  const [isRequired, setIsRequired] = useState(activity.question?.isRequired ?? true);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      await api(`/api/activities/${activity.id}/questions`, {
        method: "PUT",
        body: JSON.stringify({
          enabled,
          label: label.trim() || "Where?",
          isRequired,
        }),
      });
      onSaved();
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : "Could not save this question");
      setSubmitting(false);
    }
  }

  return (
    <Modal title={`Activity Questions — ${activity.name}`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="employee-form" noValidate>
        {submitError && <p className="error-text">{submitError}</p>}

        <label className="employee-form-checkbox">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Ask a question when this activity is selected
        </label>

        {enabled && (
          <section className="employee-form-section">
            <div className="employee-form-grid">
              <label>
                Question type
                <input type="text" value={QUESTION_TYPE_LABELS.greenhouse_row} disabled />
              </label>
              <label>
                Question label
                <input
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="Where?"
                />
              </label>
              <label className="employee-form-checkbox">
                <input type="checkbox" checked={isRequired} onChange={(e) => setIsRequired(e.target.checked)} />
                Required
              </label>
            </div>
          </section>
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
