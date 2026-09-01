import { FormEvent, useCallback, useEffect, useState } from "react";
import { PageHeader } from "../../components/layout/PageHeader";
import { useAuth } from "../../context/AuthContext";
import { api, ApiError } from "../../lib/api";

interface OrgSettingsResponse {
  longOpenShiftAlertThresholdHours: number;
}

// Administrator/Manager can view (matches GET /api/dashboard/org-settings'
// own requireRole); only Administrator can save (matches the PATCH route's
// stricter requireRole("Administrator")) — mirrored here client-side for
// UX, the server is the actual gate either way.
export function SettingsPage() {
  const { employee } = useAuth();
  const canView = employee?.securityRole === "Administrator" || employee?.securityRole === "Manager";
  const canEdit = employee?.securityRole === "Administrator";

  const [thresholdHours, setThresholdHours] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api<OrgSettingsResponse>("/api/dashboard/org-settings")
      .then((res) => {
        setThresholdHours(res.longOpenShiftAlertThresholdHours);
        setDraft(String(res.longOpenShiftAlertThresholdHours));
        setLoadError(null);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) return; // not Admin/Manager — nothing to show
        setLoadError(err instanceof ApiError ? err.message : "Could not load settings");
      });
  }, []);

  useEffect(() => {
    if (canView) load();
  }, [canView, load]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = Number(draft);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 168) {
      setSaveError("Enter a whole number of hours between 1 and 168");
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      await api<OrgSettingsResponse>("/api/dashboard/org-settings", {
        method: "PATCH",
        body: JSON.stringify({ longOpenShiftAlertThresholdHours: parsed }),
      });
      setThresholdHours(parsed);
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Could not save this setting");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader title="Settings" description="Organization-wide settings." />

      {!canView && <p className="placeholder-page">You don't have access to organization settings.</p>}

      {canView && (
        <section className="settings-section">
          <h2>Long Open Shift Alert</h2>
          <p className="settings-section-description">
            The Dashboard flags a continuously open work or break shift (across any midnight rollover) once it's
            been open longer than this many hours.
          </p>

          {loadError && <p className="error-text">{loadError}</p>}

          {thresholdHours !== null && (
            <form onSubmit={handleSubmit} className="settings-threshold-form">
              <label>
                Threshold (hours)
                <input
                  type="number"
                  min={1}
                  max={168}
                  step={1}
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setSaved(false);
                  }}
                  disabled={!canEdit || saving}
                  required
                />
              </label>
              {canEdit && (
                <button type="submit" className="employee-form-save" disabled={saving || draft === String(thresholdHours)}>
                  {saving ? "Saving..." : "Save"}
                </button>
              )}
              {!canEdit && <p className="settings-view-only-note">Only an Administrator can change this.</p>}
              {saveError && <span className="field-error">{saveError}</span>}
              {saved && <span className="settings-saved-note">Saved.</span>}
            </form>
          )}
        </section>
      )}
    </>
  );
}
