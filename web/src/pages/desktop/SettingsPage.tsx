import { FormEvent, useCallback, useEffect, useState } from "react";
import { PageHeader } from "../../components/layout/PageHeader";
import { useAuth } from "../../context/AuthContext";
import { api, ApiError } from "../../lib/api";

interface OrgSettingsResponse {
  longOpenShiftAlertThresholdHours: number;
  autoSafetyCutoffThresholdHours: number;
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

  // The runaway-shift automatic safety cutoff threshold (migration 051 /
  // runawayShiftAutoCutoff.ts) — a separate, larger threshold from the
  // review-only alert above: once a chain has gone this long since its last
  // GENUINE action, it's stopped automatically rather than just flagged.
  const [cutoffHours, setCutoffHours] = useState<number | null>(null);
  const [cutoffDraft, setCutoffDraft] = useState("");
  const [cutoffSaveError, setCutoffSaveError] = useState<string | null>(null);
  const [cutoffSaved, setCutoffSaved] = useState(false);
  const [cutoffSaving, setCutoffSaving] = useState(false);

  const load = useCallback(() => {
    api<OrgSettingsResponse>("/api/dashboard/org-settings")
      .then((res) => {
        setThresholdHours(res.longOpenShiftAlertThresholdHours);
        setDraft(String(res.longOpenShiftAlertThresholdHours));
        setCutoffHours(res.autoSafetyCutoffThresholdHours);
        setCutoffDraft(String(res.autoSafetyCutoffThresholdHours));
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

  async function handleCutoffSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = Number(cutoffDraft);
    if (!Number.isInteger(parsed) || parsed < 24 || parsed > 336) {
      setCutoffSaveError("Enter a whole number of hours between 24 and 336");
      return;
    }
    setCutoffSaving(true);
    setCutoffSaveError(null);
    setCutoffSaved(false);
    try {
      await api<OrgSettingsResponse>("/api/dashboard/org-settings", {
        method: "PATCH",
        body: JSON.stringify({ autoSafetyCutoffThresholdHours: parsed }),
      });
      setCutoffHours(parsed);
      setCutoffSaved(true);
    } catch (err) {
      setCutoffSaveError(err instanceof ApiError ? err.message : "Could not save this setting");
    } finally {
      setCutoffSaving(false);
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

      {canView && (
        <section className="settings-section">
          <h2>Runaway Shift Automatic Safety Cutoff</h2>
          <p className="settings-section-description">
            If a shift chain (across any midnight rollovers) goes this many hours with no genuine employee/device or
            administrator action, it's automatically stopped instead of continuing indefinitely — closed with an
            assumed end time that shows up under "Automatically Stopped Shifts" for review. Must stay greater than
            the alert threshold above, so an admin has a chance to act on the alert first.
          </p>

          {cutoffHours !== null && (
            <form onSubmit={handleCutoffSubmit} className="settings-threshold-form">
              <label>
                Threshold (hours)
                <input
                  type="number"
                  min={24}
                  max={336}
                  step={1}
                  value={cutoffDraft}
                  onChange={(e) => {
                    setCutoffDraft(e.target.value);
                    setCutoffSaved(false);
                  }}
                  disabled={!canEdit || cutoffSaving}
                  required
                />
              </label>
              {canEdit && (
                <button type="submit" className="employee-form-save" disabled={cutoffSaving || cutoffDraft === String(cutoffHours)}>
                  {cutoffSaving ? "Saving..." : "Save"}
                </button>
              )}
              {!canEdit && <p className="settings-view-only-note">Only an Administrator can change this.</p>}
              {cutoffSaveError && <span className="field-error">{cutoffSaveError}</span>}
              {cutoffSaved && <span className="settings-saved-note">Saved.</span>}
            </form>
          )}
        </section>
      )}
    </>
  );
}
