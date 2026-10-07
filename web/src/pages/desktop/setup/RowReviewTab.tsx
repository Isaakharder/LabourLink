import { FormEvent, useCallback, useEffect, useState } from "react";
import { useAuth } from "../../../context/AuthContext";
import { api, ApiError } from "../../../lib/api";

export const MIN_ROW_REVIEW_WINDOW_DAYS = 1;
export const MAX_ROW_REVIEW_WINDOW_DAYS = 365;

interface RowReviewWindowResponse {
  rowReviewWindowDays: number;
}

// Setup > Row Review: the "Row review window (calendar days)" org setting
// (GET/PUT /api/row-completions/review-window, 057_row_review_window.sql).
// Administrator/Manager can view, only Administrator can save — the same
// gates the server enforces; mirrored here for UX only.
export function RowReviewTab() {
  const { employee } = useAuth();
  const canView = employee?.securityRole === "Administrator" || employee?.securityRole === "Manager";
  const canEdit = employee?.securityRole === "Administrator";

  const [windowDays, setWindowDays] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api<RowReviewWindowResponse>("/api/row-completions/review-window")
      .then((res) => {
        setWindowDays(res.rowReviewWindowDays);
        setDraft(String(res.rowReviewWindowDays));
        setLoadError(null);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) return;
        setLoadError(err instanceof ApiError ? err.message : "Could not load the row review window");
      });
  }, []);

  useEffect(() => {
    if (canView) load();
  }, [canView, load]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = draft.trim();
    const parsed = Number(trimmed);
    if (!/^\d+$/.test(trimmed) || !Number.isInteger(parsed) || parsed < MIN_ROW_REVIEW_WINDOW_DAYS || parsed > MAX_ROW_REVIEW_WINDOW_DAYS) {
      setSaveError(`Enter a whole number of days from ${MIN_ROW_REVIEW_WINDOW_DAYS} to ${MAX_ROW_REVIEW_WINDOW_DAYS}`);
      setSaved(false);
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const res = await api<RowReviewWindowResponse>("/api/row-completions/review-window", {
        method: "PUT",
        body: JSON.stringify({ rowReviewWindowDays: parsed }),
      });
      setWindowDays(res.rowReviewWindowDays);
      setDraft(String(res.rowReviewWindowDays));
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Could not save this setting");
    } finally {
      setSaving(false);
    }
  }

  if (!canView) return <p className="placeholder-page">You don't have access to row review settings.</p>;

  return (
    <section className="settings-section">
      <h2>Row review window</h2>
      <p className="settings-section-description">
        Visits to the same row for the same activity that are fewer than this many calendar days apart are reviewed
        together, whoever worked them: if a window has more than one unfinished-review visit, it shows “Needs review” on
        Inputs and its stems aren’t counted until it’s resolved. A gap of this many days or more starts a new window,
        with its own stems and time. Days are calendar dates in the organization’s time zone. Changing this regroups
        only visits that haven’t been reviewed yet — confirmed row completions never change.
      </p>

      {loadError && <p className="error-text">{loadError}</p>}

      {windowDays !== null && (
        <form onSubmit={handleSubmit} className="settings-threshold-form" noValidate>
          <label>
            Row review window (calendar days)
            <input
              type="number"
              min={MIN_ROW_REVIEW_WINDOW_DAYS}
              max={MAX_ROW_REVIEW_WINDOW_DAYS}
              step={1}
              inputMode="numeric"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setSaved(false);
                setSaveError(null);
              }}
              disabled={!canEdit || saving}
              required
            />
          </label>
          {canEdit && (
            <button type="submit" className="employee-form-save" disabled={saving || draft === String(windowDays)}>
              {saving ? "Saving..." : "Save"}
            </button>
          )}
          {!canEdit && <p className="settings-view-only-note">Only an Administrator can change this.</p>}
          {saveError && <span className="field-error">{saveError}</span>}
          {saved && <span className="settings-saved-note">Saved.</span>}
        </form>
      )}
    </section>
  );
}
