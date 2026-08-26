import { FormEvent, useEffect, useRef, useState } from "react";
import { Modal } from "../ui/Modal";
import { Avatar } from "./Avatar";
import { api, ApiError } from "../../lib/api";
import { Employee, EmployeeBreakProfile, GENDERS, LANGUAGES, NATIONALITIES } from "../../lib/employeeTypes";
import { ActivityGroup } from "../../lib/activityTypes";
import { DEFAULT_WORK_PERMIT_LEAD_MONTHS, WORK_PERMIT_LEAD_MONTH_OPTIONS } from "../../lib/workPermitTypes";

interface EmployeeFormModalProps {
  employee: Employee | null; // null = create mode
  onClose: () => void;
  onSaved: () => void;
}

interface FormState {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  gender: string;
  nationality: string;
  preferredLanguage: string;
  employeeNumber: string;
  startDate: string;
  jobGroup: string;
  isActive: boolean;
  securityRoleId: string;
  teamRoleId: string;
  breakProfileId: string;
  email: string;
  phoneNumber: string;
  notes: string;
  activityGroupIds: Set<string>;
  workPermitExpiryDate: string;
  // "6" | "1" | "2" | "3" | "12" | "custom" — kept as the select's own
  // string value rather than splitting into two booleans, same reasoning
  // BreakProfileEditor.tsx's direction select uses.
  workPermitLeadChoice: string;
  workPermitLeadCustomDays: string;
}

const SECURITY_ROLES = [
  { id: 1, name: "Employee" },
  { id: 2, name: "Crew Leader" },
  { id: 3, name: "Supervisor" },
  { id: 4, name: "Manager" },
  { id: 5, name: "Administrator" },
];
const TEAM_ROLES = [
  { id: 1, name: "Team Member" },
  { id: 2, name: "Team Leader" },
  { id: 3, name: "Assistant Team Leader" },
];

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const ACCEPTED_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

function toFormState(employee: Employee | null): FormState {
  return {
    firstName: employee?.firstName ?? "",
    lastName: employee?.lastName ?? "",
    dateOfBirth: employee?.dateOfBirth ?? "",
    gender: employee?.gender ?? "",
    nationality: employee?.nationality ?? "",
    preferredLanguage: employee?.preferredLanguage ?? "",
    employeeNumber: employee?.employeeNumber ?? "",
    startDate: employee?.startDate ?? "",
    jobGroup: employee?.jobGroup ?? "",
    isActive: employee?.isActive ?? true,
    securityRoleId: String(employee?.securityRoleId ?? 1),
    teamRoleId: String(employee?.teamRoleId ?? 1),
    breakProfileId: employee?.breakProfileId ?? "",
    email: employee?.email ?? "",
    phoneNumber: employee?.phoneNumber ?? "",
    notes: employee?.notes ?? "",
    activityGroupIds: new Set(employee?.activityGroups.map((g) => g.id) ?? []),
    workPermitExpiryDate: employee?.workPermitExpiryDate ?? "",
    workPermitLeadChoice:
      employee?.workPermitNotifyLeadDays != null
        ? "custom"
        : String(employee?.workPermitNotifyLeadMonths ?? DEFAULT_WORK_PERMIT_LEAD_MONTHS),
    workPermitLeadCustomDays: employee?.workPermitNotifyLeadDays != null ? String(employee.workPermitNotifyLeadDays) : "",
  };
}

export function EmployeeFormModal({ employee, onClose, onSaved }: EmployeeFormModalProps) {
  const isEdit = Boolean(employee);
  const [form, setForm] = useState<FormState>(() => toFormState(employee));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [removePhoto, setRemovePhoto] = useState(false);
  const [photoPickError, setPhotoPickError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [activityGroups, setActivityGroups] = useState<ActivityGroup[]>([]);
  useEffect(() => {
    api<{ activityGroups: ActivityGroup[] }>("/api/activity-groups?status=active")
      .then((res) => setActivityGroups(res.activityGroups))
      .catch(() => {});
  }, []);

  const [breakProfiles, setBreakProfiles] = useState<EmployeeBreakProfile[]>([]);
  useEffect(() => {
    api<{ breakProfiles: EmployeeBreakProfile[] }>("/api/break-profiles?status=active")
      .then((res) => setBreakProfiles(res.breakProfiles))
      .catch(() => {});
  }, []);
  // The employee's current profile stays selectable even if it's since been
  // deactivated (history stays visible), but only if it isn't already in the
  // active list above — a brand-new assignment must still pick an active one.
  const selectableBreakProfiles =
    employee?.breakProfile && !employee.breakProfile.isActive
      ? [...breakProfiles, employee.breakProfile]
      : breakProfiles;

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function toggleActivityGroup(id: string) {
    setForm((f) => {
      const next = new Set(f.activityGroupIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...f, activityGroupIds: next };
    });
  }

  function handlePhotoPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file later
    if (!file) return;

    if (!ACCEPTED_PHOTO_TYPES.includes(file.type)) {
      setPhotoPickError("Only JPEG, PNG, or WebP images are allowed");
      return;
    }
    if (file.size > MAX_PHOTO_BYTES) {
      setPhotoPickError("Photo must be 5 MB or smaller");
      return;
    }

    setPhotoPickError(null);
    setRemovePhoto(false);
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
  }

  function handleClearStagedPhoto() {
    setPhotoFile(null);
    setPhotoPreview(null);
  }

  function handleRemoveExistingPhoto() {
    setPhotoFile(null);
    setPhotoPreview(null);
    setRemovePhoto(true);
  }

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!form.firstName.trim()) next.firstName = "First name is required";
    if (!form.lastName.trim()) next.lastName = "Last name is required";
    if (!form.startDate) next.startDate = "Start date is required";
    if (!NATIONALITIES.includes(form.nationality as (typeof NATIONALITIES)[number])) {
      next.nationality = "Nationality is required";
    }
    if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      next.email = "Email address is not valid";
    }
    if (form.workPermitExpiryDate && form.workPermitLeadChoice === "custom") {
      const n = Number(form.workPermitLeadCustomDays);
      if (!form.workPermitLeadCustomDays || !Number.isInteger(n) || n < 1 || n > 3650) {
        next.workPermitNotifyLeadDays = "Enter a whole number of days between 1 and 3650";
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return; // guard against a double-submit racing past the disabled button
    setSubmitError(null);
    if (!validate()) return;

    const isDeactivating = isEdit && employee!.isActive && !form.isActive;
    if (isDeactivating && employee!.device) {
      const proceed = window.confirm(
        `${employee!.firstName} ${employee!.lastName} has an assigned device (${
          employee!.device.name ?? "unnamed"
        }). Deactivating will end that assignment — the device itself stays paired and can be reassigned. Deactivate anyway?`
      );
      if (!proceed) return;
    }

    setSubmitting(true);
    try {
      const payload = {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        dateOfBirth: form.dateOfBirth || null,
        gender: form.gender || null,
        nationality: form.nationality,
        preferredLanguage: form.preferredLanguage || null,
        employeeNumber: form.employeeNumber.trim() || null,
        startDate: form.startDate,
        jobGroup: form.jobGroup.trim() || null,
        isActive: form.isActive,
        securityRoleId: Number(form.securityRoleId),
        teamRoleId: Number(form.teamRoleId),
        breakProfileId: form.breakProfileId || null,
        email: form.email.trim() || null,
        phoneNumber: form.phoneNumber.trim() || null,
        notes: form.notes.trim() || null,
        workPermitExpiryDate: form.workPermitExpiryDate || null,
        // Server clears both when workPermitExpiryDate is null regardless
        // of what's sent here — see employees.ts's resolveWorkPermitUpdate
        // — so these are only meaningful when a date is present.
        ...(form.workPermitExpiryDate
          ? form.workPermitLeadChoice === "custom"
            ? { workPermitNotifyLeadDays: Number(form.workPermitLeadCustomDays) }
            : { workPermitNotifyLeadMonths: Number(form.workPermitLeadChoice) }
          : {}),
      };

      let employeeId: string;
      if (isEdit) {
        const res = await api<{ employee: Employee }>(`/api/employees/${employee!.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        employeeId = res.employee.id;
      } else {
        const res = await api<{ employee: Employee }>("/api/employees", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        employeeId = res.employee.id;
      }

      if (photoFile) {
        const formData = new FormData();
        formData.append("photo", photoFile);
        try {
          await api(`/api/employees/${employeeId}/photo`, { method: "POST", body: formData });
        } catch {
          setSubmitError("Employee saved, but the photo failed to upload. You can try again below.");
          setSubmitting(false);
          return;
        }
      } else if (removePhoto && isEdit) {
        await api(`/api/employees/${employeeId}/photo`, { method: "DELETE" }).catch(() => {});
      }

      const currentGroupIds = new Set(employee?.activityGroups.map((g) => g.id) ?? []);
      const desiredGroupIds = form.activityGroupIds;
      const groupsChanged =
        currentGroupIds.size !== desiredGroupIds.size ||
        [...desiredGroupIds].some((gid) => !currentGroupIds.has(gid));
      if (groupsChanged) {
        try {
          await api(`/api/employees/${employeeId}/activity-groups`, {
            method: "PUT",
            body: JSON.stringify({ activityGroupIds: [...desiredGroupIds] }),
          });
        } catch {
          setSubmitError("Employee saved, but activity groups failed to update. You can try again below.");
          setSubmitting(false);
          return;
        }
      }

      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.errors) {
        setErrors(err.errors);
      } else if (err instanceof ApiError) {
        setSubmitError(err.message);
      } else {
        setSubmitError("Something went wrong saving this employee");
      }
      setSubmitting(false);
    }
  }

  const previewUrl = photoPreview ?? (removePhoto ? null : employee?.photoUrl ?? null);
  const deviceWarning =
    isEdit && employee?.device && form.isActive === false
      ? `${employee.firstName} has an assigned device (${employee.device.name ?? "unnamed"}). Saving will end that assignment; the device itself stays paired for reassignment.`
      : null;

  return (
    <Modal title={isEdit ? "Edit Employee" : "Add Employee"} onClose={onClose} wide>
      <form onSubmit={handleSubmit} className="employee-form" noValidate>
        {submitError && <p className="error-text">{submitError}</p>}

        <section className="employee-form-section">
          <h3>Personal</h3>
          <div className="employee-form-photo">
            <Avatar photoUrl={previewUrl} firstName={form.firstName || "?"} lastName={form.lastName} size="large" />
            <div className="employee-form-photo-controls">
              <button type="button" onClick={() => fileInputRef.current?.click()}>
                {previewUrl ? "Replace photo" : "Upload photo"}
              </button>
              {photoFile && (
                <button type="button" className="employee-form-photo-cancel" onClick={handleClearStagedPhoto}>
                  Cancel
                </button>
              )}
              {!photoFile && previewUrl && (
                <button type="button" className="employee-form-photo-cancel" onClick={handleRemoveExistingPhoto}>
                  Remove photo
                </button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={handlePhotoPick}
                hidden
              />
            </div>
            {photoPickError && <p className="error-text">{photoPickError}</p>}
          </div>

          <div className="employee-form-grid">
            <label>
              First name *
              <input
                type="text"
                value={form.firstName}
                onChange={(e) => set("firstName", e.target.value)}
                required
              />
              {errors.firstName && <span className="field-error">{errors.firstName}</span>}
            </label>
            <label>
              Last name *
              <input
                type="text"
                value={form.lastName}
                onChange={(e) => set("lastName", e.target.value)}
                required
              />
              {errors.lastName && <span className="field-error">{errors.lastName}</span>}
            </label>
            <label>
              Date of birth
              <input
                type="date"
                value={form.dateOfBirth}
                onChange={(e) => set("dateOfBirth", e.target.value)}
              />
            </label>
            <label>
              Gender
              <select value={form.gender} onChange={(e) => set("gender", e.target.value)}>
                <option value="">—</option>
                {GENDERS.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Nationality *
              <select
                value={form.nationality}
                onChange={(e) => set("nationality", e.target.value)}
                required
              >
                <option value="">Select...</option>
                {NATIONALITIES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              {errors.nationality && <span className="field-error">{errors.nationality}</span>}
            </label>
            <label>
              Preferred language
              <select
                value={form.preferredLanguage}
                onChange={(e) => set("preferredLanguage", e.target.value)}
              >
                <option value="">—</option>
                {LANGUAGES.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>

        <section className="employee-form-section">
          <h3>Employment</h3>
          <div className="employee-form-grid">
            <label>
              Employee number
              <input
                type="text"
                value={form.employeeNumber}
                onChange={(e) => set("employeeNumber", e.target.value)}
              />
              {errors.employeeNumber && <span className="field-error">{errors.employeeNumber}</span>}
            </label>
            <label>
              Start date *
              <input
                type="date"
                value={form.startDate}
                onChange={(e) => set("startDate", e.target.value)}
                required
              />
              {errors.startDate && <span className="field-error">{errors.startDate}</span>}
            </label>
            <label>
              Work Permit Expiry Date
              <input
                type="date"
                value={form.workPermitExpiryDate}
                onChange={(e) => set("workPermitExpiryDate", e.target.value)}
              />
              {errors.workPermitExpiryDate && <span className="field-error">{errors.workPermitExpiryDate}</span>}
            </label>
            {form.workPermitExpiryDate && (
              <label>
                Notify me before
                <select value={form.workPermitLeadChoice} onChange={(e) => set("workPermitLeadChoice", e.target.value)}>
                  {WORK_PERMIT_LEAD_MONTH_OPTIONS.map((m) => (
                    <option key={m} value={m}>
                      {m} month{m === 1 ? "" : "s"}
                    </option>
                  ))}
                  <option value="custom">Custom number of days</option>
                </select>
              </label>
            )}
            {form.workPermitExpiryDate && form.workPermitLeadChoice === "custom" && (
              <label>
                Custom lead time (days)
                <input
                  type="number"
                  min={1}
                  max={3650}
                  value={form.workPermitLeadCustomDays}
                  onChange={(e) => set("workPermitLeadCustomDays", e.target.value)}
                />
                {errors.workPermitNotifyLeadDays && <span className="field-error">{errors.workPermitNotifyLeadDays}</span>}
              </label>
            )}
            <label>
              Job group
              <input type="text" value={form.jobGroup} onChange={(e) => set("jobGroup", e.target.value)} />
            </label>
            <label>
              Security role
              <select value={form.securityRoleId} onChange={(e) => set("securityRoleId", e.target.value)}>
                {SECURITY_ROLES.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Team role
              <select value={form.teamRoleId} onChange={(e) => set("teamRoleId", e.target.value)}>
                {TEAM_ROLES.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Break Profile
              <select value={form.breakProfileId} onChange={(e) => set("breakProfileId", e.target.value)}>
                <option value="">None</option>
                {selectableBreakProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {!p.isActive ? " (inactive)" : ""}
                  </option>
                ))}
              </select>
              {errors.breakProfileId && <span className="field-error">{errors.breakProfileId}</span>}
            </label>
            <label className="employee-form-checkbox">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => set("isActive", e.target.checked)}
              />
              Active
            </label>
          </div>
          <h3>Activity Groups</h3>
          {activityGroups.length === 0 ? (
            <p className="placeholder-page">No active activity groups exist yet.</p>
          ) : (
            <div className="activity-checklist">
              {activityGroups.map((g) => (
                <label key={g.id} className="activity-checklist-item">
                  <input
                    type="checkbox"
                    checked={form.activityGroupIds.has(g.id)}
                    onChange={() => toggleActivityGroup(g.id)}
                  />
                  {g.name}
                </label>
              ))}
            </div>
          )}
          {deviceWarning && <p className="form-warning">{deviceWarning}</p>}
        </section>

        <section className="employee-form-section">
          <h3>Contact</h3>
          <div className="employee-form-grid">
            <label>
              Email
              <input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
              {errors.email && <span className="field-error">{errors.email}</span>}
            </label>
            <label>
              Phone number
              <input
                type="tel"
                placeholder="e.g. (555) 123-4567"
                value={form.phoneNumber}
                onChange={(e) => set("phoneNumber", e.target.value)}
              />
            </label>
          </div>
        </section>

        <section className="employee-form-section">
          <h3>Additional</h3>
          <label>
            Notes
            <textarea rows={3} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
          </label>
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
