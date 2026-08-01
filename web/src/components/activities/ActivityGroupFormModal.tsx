import { FormEvent, useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import { Activity, ActivityGroup, ActivityGroupMember } from "../../lib/activityTypes";

interface ActivityGroupFormModalProps {
  group: ActivityGroup | null; // null = create mode
  onClose: () => void;
  onSaved: () => void;
}

interface FormState {
  name: string;
  description: string;
  isActive: boolean;
  activityIds: Set<string>;
}

function toFormState(group: ActivityGroup | null): FormState {
  return {
    name: group?.name ?? "",
    description: group?.description ?? "",
    isActive: group?.isActive ?? true,
    activityIds: new Set(group?.activities.map((a) => a.id) ?? []),
  };
}

export function ActivityGroupFormModal({ group, onClose, onSaved }: ActivityGroupFormModalProps) {
  const isEdit = Boolean(group);
  const [form, setForm] = useState<FormState>(() => toFormState(group));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [activeActivities, setActiveActivities] = useState<Activity[] | null>(null);

  useEffect(() => {
    api<{ activities: Activity[] }>("/api/activities?status=active")
      .then((res) => setActiveActivities(res.activities))
      .catch(() => setActiveActivities([]));
  }, []);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function toggleActivity(id: string) {
    setForm((f) => {
      const next = new Set(f.activityIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...f, activityIds: next };
    });
  }

  // Checklist = every currently-active activity, plus any already-assigned
  // activity even if it has since gone inactive — inactive members stay
  // visible (and removable) instead of silently vanishing from the editor.
  const alreadyAssignedInactive: ActivityGroupMember[] =
    group?.activities.filter((a) => !a.isActive) ?? [];

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!form.name.trim()) next.name = "Group name is required";
    if (form.activityIds.size === 0) next.activityIds = "At least one activity is required";
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
        description: form.description.trim() || null,
        isActive: form.isActive,
        activityIds: [...form.activityIds],
      };

      if (isEdit) {
        await api(`/api/activity-groups/${group!.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await api("/api/activity-groups", { method: "POST", body: JSON.stringify(payload) });
      }
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.errors) {
        setErrors(err.errors);
      } else if (err instanceof ApiError) {
        setSubmitError(err.message);
      } else {
        setSubmitError("Something went wrong saving this activity group");
      }
      setSubmitting(false);
    }
  }

  return (
    <Modal title={isEdit ? "Edit Activity Group" : "Add Activity Group"} onClose={onClose} wide>
      <form onSubmit={handleSubmit} className="employee-form" noValidate>
        {submitError && <p className="error-text">{submitError}</p>}

        <section className="employee-form-section">
          <div className="employee-form-grid">
            <label>
              Group name *
              <input type="text" value={form.name} onChange={(e) => set("name", e.target.value)} required />
              {errors.name && <span className="field-error">{errors.name}</span>}
            </label>
            <label className="employee-form-checkbox">
              <input type="checkbox" checked={form.isActive} onChange={(e) => set("isActive", e.target.checked)} />
              Active
            </label>
          </div>
          <label>
            Description
            <textarea rows={2} value={form.description} onChange={(e) => set("description", e.target.value)} />
          </label>
        </section>

        <section className="employee-form-section">
          <h3>Activities *</h3>
          {activeActivities === null ? (
            <p>Loading activities...</p>
          ) : activeActivities.length === 0 && alreadyAssignedInactive.length === 0 ? (
            <p className="placeholder-page">No activities exist yet — add one on the Activities tab first.</p>
          ) : (
            <div className="activity-checklist">
              {activeActivities.map((a) => (
                <label key={a.id} className="activity-checklist-item">
                  <input
                    type="checkbox"
                    checked={form.activityIds.has(a.id)}
                    onChange={() => toggleActivity(a.id)}
                  />
                  {a.name}
                </label>
              ))}
              {alreadyAssignedInactive.map((a) => (
                <label key={a.id} className="activity-checklist-item activity-checklist-item-inactive">
                  <input
                    type="checkbox"
                    checked={form.activityIds.has(a.id)}
                    onChange={() => toggleActivity(a.id)}
                  />
                  {a.name} (inactive)
                </label>
              ))}
            </div>
          )}
          {errors.activityIds && <span className="field-error">{errors.activityIds}</span>}
        </section>

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
