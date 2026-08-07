import { FormEvent, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import {
  Activity,
  ActivityQuestionDraft,
  DENSITY_SOURCES,
  DENSITY_SOURCE_LABELS,
  DensitySource,
  SPEED_UNIT_SUGGESTIONS,
} from "../../lib/activityTypes";
import { QuestionsEditor, serializeQuestionDrafts, toQuestionDrafts } from "./QuestionsEditor";

interface ActivityFormModalProps {
  activity: Activity | null; // null = create mode
  onClose: () => void;
  onSaved: () => void;
}

interface FormState {
  name: string;
  normalSpeed: string;
  speedUnit: string;
  minimumDurationMinutes: string;
  isActive: boolean;
  densitySource: "" | DensitySource;
}

function toFormState(activity: Activity | null): FormState {
  return {
    name: activity?.name ?? "",
    normalSpeed: activity?.normalSpeed != null ? String(activity.normalSpeed) : "",
    speedUnit: activity?.speedUnit ?? "",
    minimumDurationMinutes: activity ? String(activity.minimumDurationMinutes) : "0",
    isActive: activity?.isActive ?? true,
    densitySource: activity?.densitySource ?? "",
  };
}

export function ActivityFormModal({ activity, onClose, onSaved }: ActivityFormModalProps) {
  const isEdit = Boolean(activity);
  const [form, setForm] = useState<FormState>(() => toFormState(activity));
  const [questions, setQuestions] = useState<ActivityQuestionDraft[]>(() => toQuestionDrafts(activity?.questions ?? []));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!form.name.trim()) next.name = "Activity name is required";
    if (form.normalSpeed.trim()) {
      const n = Number(form.normalSpeed);
      if (!Number.isFinite(n) || n <= 0) next.normalSpeed = "Normal speed must be greater than 0";
    }
    const duration = Number(form.minimumDurationMinutes);
    if (form.minimumDurationMinutes.trim() === "" || !Number.isInteger(duration) || duration < 0) {
      next.minimumDurationMinutes = "Minimum duration must be zero or greater";
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitError(null);
    if (!validate()) return;

    setSubmitting(true);
    try {
      const payload = {
        name: form.name.trim(),
        normalSpeed: form.normalSpeed.trim() ? Number(form.normalSpeed) : null,
        speedUnit: form.speedUnit.trim() || null,
        densitySource: form.densitySource || null,
        minimumDurationMinutes: Number(form.minimumDurationMinutes),
        isActive: form.isActive,
        // Sent as a complete list every save (create or edit), including
        // when empty — the server treats an empty array as "no questions,"
        // distinct from the field being absent (see PATCH /api/activities/
        // :id, which leaves the question list untouched if omitted
        // entirely; this modal always has an opinion, so it's always sent).
        questions: serializeQuestionDrafts(questions),
      };

      if (isEdit) {
        await api(`/api/activities/${activity!.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await api("/api/activities", { method: "POST", body: JSON.stringify(payload) });
      }
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.errors) {
        setErrors(err.errors);
      } else if (err instanceof ApiError) {
        setSubmitError(err.message);
      } else {
        setSubmitError("Something went wrong saving this activity");
      }
      setSubmitting(false);
    }
  }

  return (
    <Modal title={isEdit ? "Edit Activity" : "Add Activity"} onClose={onClose}>
      <form onSubmit={handleSubmit} className="employee-form" noValidate>
        {submitError && <p className="error-text">{submitError}</p>}

        <section className="employee-form-section">
          <div className="employee-form-grid">
            <label>
              Activity name *
              <input type="text" value={form.name} onChange={(e) => set("name", e.target.value)} required />
              {errors.name && <span className="field-error">{errors.name}</span>}
            </label>
            <label>
              Normal speed
              <input
                type="number"
                step="any"
                min="0"
                value={form.normalSpeed}
                onChange={(e) => set("normalSpeed", e.target.value)}
                placeholder="e.g. 300"
              />
              {errors.normalSpeed && <span className="field-error">{errors.normalSpeed}</span>}
            </label>
            <label>
              Speed unit
              <input
                type="text"
                list="speed-unit-suggestions"
                value={form.speedUnit}
                onChange={(e) => set("speedUnit", e.target.value)}
                placeholder="e.g. kg/hour"
              />
              <datalist id="speed-unit-suggestions">
                {SPEED_UNIT_SUGGESTIONS.map((u) => (
                  <option key={u} value={u} />
                ))}
              </datalist>
            </label>
            <label>
              Density source
              <select
                value={form.densitySource}
                onChange={(e) => set("densitySource", e.target.value as "" | DensitySource)}
              >
                <option value="">None</option>
                {DENSITY_SOURCES.map((d) => (
                  <option key={d} value={d}>
                    {DENSITY_SOURCE_LABELS[d]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Minimum duration (minutes) *
              <input
                type="number"
                step="1"
                min="0"
                value={form.minimumDurationMinutes}
                onChange={(e) => set("minimumDurationMinutes", e.target.value)}
                required
              />
              {errors.minimumDurationMinutes && (
                <span className="field-error">{errors.minimumDurationMinutes}</span>
              )}
            </label>
            <label className="employee-form-checkbox">
              <input type="checkbox" checked={form.isActive} onChange={(e) => set("isActive", e.target.checked)} />
              Active
            </label>
          </div>
        </section>

        <QuestionsEditor questions={questions} onChange={setQuestions} error={errors.questions} />

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
