import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Save } from "lucide-react";
import { useUnsavedChangesGuard } from "../../context/UnsavedChangesContext";
import { api, ApiError } from "../../lib/api";
import { reportingPeriodFor } from "../../lib/displaySlideshow";
import {
  ActivitySlideSetting,
  DisplaySlidesConfig,
  GreenhouseDisplaySummary,
  ReportWeek,
} from "../../lib/greenhouseLiveTypes";
import { formatDateLong, todayInAppTimezone } from "../../lib/timezone";

// Display > Setup: which activities this TV turns into employee speed-ranking
// slides, and over which reporting period. Settings are per display, so two
// TVs can show different slides. The map (Display > Map) is always the first
// slide; with nothing sent to the TV, or no work in the period, the TV shows
// only the map.

interface Draft {
  reportWeek: ReportWeek;
  reportIncludeToday: boolean;
  mapSlideSeconds: string;
  activities: (ActivitySlideSetting & { targetText: string; minHoursText: string; topNText: string; secondsText: string })[];
}

function toDraft(config: DisplaySlidesConfig): Draft {
  return {
    reportWeek: config.reportWeek,
    reportIncludeToday: config.reportIncludeToday,
    mapSlideSeconds: String(config.mapSlideSeconds),
    activities: config.activities.map((a) => ({
      ...a,
      targetText: a.targetOverride != null ? String(a.targetOverride) : "",
      minHoursText: String(a.minimumActivityHours),
      topNText: a.topN != null ? String(a.topN) : "",
      secondsText: String(a.slideSeconds),
    })),
  };
}

function draftKey(d: Draft | null): string {
  if (!d) return "";
  return JSON.stringify([
    d.reportWeek,
    d.reportIncludeToday,
    d.mapSlideSeconds,
    d.activities.map((a) => [a.activityId, a.sendToTv, a.targetText, a.minHoursText, a.topNText, a.secondsText]),
  ]);
}

function parseWhole(text: string): number | null {
  return /^\d+$/.test(text.trim()) ? Number(text.trim()) : null;
}

function parseDecimal(text: string): number | null {
  const t = text.trim();
  if (t === "" || !/^\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

export function DisplaySetupPage() {
  const { setUnsavedChanges } = useUnsavedChangesGuard();
  const [displays, setDisplays] = useState<GreenhouseDisplaySummary[] | null>(null);
  const [displayId, setDisplayId] = useState<string | null>(null);
  const [saved, setSaved] = useState<Draft | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    api<{ displays: GreenhouseDisplaySummary[] }>("/api/greenhouse/displays")
      .then((res) => {
        setDisplays(res.displays);
        setDisplayId((prev) => prev ?? res.displays.find((d) => d.isActive)?.id ?? res.displays[0]?.id ?? null);
      })
      .catch(() => setLoadError("Could not load displays."));
  }, []);

  const loadConfig = useCallback((id: string) => {
    setDraft(null);
    setSaved(null);
    setLoadError(null);
    api<DisplaySlidesConfig>(`/api/greenhouse/displays/${id}/slides-config`)
      .then((config) => {
        const d = toDraft(config);
        setSaved(d);
        setDraft(d);
      })
      .catch(() => setLoadError("Could not load this display's settings."));
  }, []);

  useEffect(() => {
    if (displayId) loadConfig(displayId);
  }, [displayId, loadConfig]);

  const isDirty = draftKey(draft) !== draftKey(saved);
  const selected = displays?.find((d) => d.id === displayId) ?? null;
  useEffect(() => {
    setUnsavedChanges(isDirty, `Unsaved TV settings for ${selected?.name ?? "this display"} will be lost. Leave without saving?`);
    return () => setUnsavedChanges(false);
  }, [isDirty, selected, setUnsavedChanges]);

  const period = useMemo(
    () => (draft ? reportingPeriodFor(draft.reportWeek, draft.reportIncludeToday, todayInAppTimezone()) : null),
    [draft]
  );

  function updateActivity(activityId: string, patch: Partial<Draft["activities"][number]>) {
    setDraft((d) => (d ? { ...d, activities: d.activities.map((a) => (a.activityId === activityId ? { ...a, ...patch } : a)) } : d));
  }

  // Returns an error message, or the request body.
  function buildBody(d: Draft): string | object {
    const mapSeconds = parseWhole(d.mapSlideSeconds);
    if (mapSeconds == null || mapSeconds < 5 || mapSeconds > 600) return "Map slide duration must be 5–600 seconds.";
    const activities = [];
    for (const a of d.activities) {
      const target = a.targetText.trim() === "" ? null : parseDecimal(a.targetText);
      if (a.targetText.trim() !== "" && (target == null || target <= 0)) return `${a.name}: target must be a positive number, or empty.`;
      const minHours = parseDecimal(a.minHoursText);
      if (minHours == null || minHours > 168) return `${a.name}: minimum activity hours must be 0–168.`;
      const topN = a.topNText.trim() === "" ? null : parseWhole(a.topNText);
      if (a.topNText.trim() !== "" && (topN == null || topN < 1 || topN > 200)) return `${a.name}: Top N must be 1–200, or All.`;
      const seconds = parseWhole(a.secondsText);
      if (seconds == null || seconds < 5 || seconds > 600) return `${a.name}: slide duration must be 5–600 seconds.`;
      activities.push({ activityId: a.activityId, sendToTv: a.sendToTv, targetOverride: target, minimumActivityHours: minHours, topN, slideSeconds: seconds });
    }
    return { reportWeek: d.reportWeek, reportIncludeToday: d.reportIncludeToday, mapSlideSeconds: mapSeconds, activities };
  }

  async function handleSave() {
    if (!draft || !displayId) return;
    const body = buildBody(draft);
    if (typeof body === "string") {
      setSaveError(body);
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    try {
      const config = await api<DisplaySlidesConfig>(`/api/greenhouse/displays/${displayId}/slides-config`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      const d = toDraft(config);
      setSaved(d);
      setDraft(d);
      setSaveSuccess(true);
      window.setTimeout(() => setSaveSuccess(false), 4000);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Could not save these TV settings.");
    } finally {
      setSaving(false);
    }
  }

  const sentCount = draft?.activities.filter((a) => a.sendToTv).length ?? 0;

  return (
    <div className="display-setup-page">
      <div className="display-setup-header">
        <div>
          <h1>Display setup</h1>
          <p className="display-setup-subtitle">
            Choose which activities this TV shows as employee speed rankings. The{" "}
            <Link to="/display/map">map</Link> is always the first slide; with nothing sent to the TV, or no work in the
            reporting period, the TV shows only the map.
          </p>
        </div>
        <label className="greenhouse-office-field display-setup-display-select">
          Display
          <span className="greenhouse-office-select-wrap">
            <select
              className="greenhouse-office-select"
              value={displayId ?? ""}
              onChange={(e) => {
                if (isDirty && !window.confirm("Discard unsaved TV settings?")) return;
                setDisplayId(e.target.value || null);
              }}
              disabled={!displays || displays.length === 0}
            >
              {(!displays || displays.length === 0) && <option value="">No displays yet</option>}
              {displays?.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.isActive ? "" : " (inactive)"}
                </option>
              ))}
            </select>
          </span>
        </label>
      </div>

      {displays && displays.length === 0 && (
        <p className="display-setup-empty">
          No displays yet — create one on the <Link to="/display/map">Map</Link> page first.
        </p>
      )}
      {loadError && <p className="error-text">{loadError}</p>}

      {draft && (
        <>
          <section className="display-setup-section">
            <h2>Reporting period</h2>
            <div className="display-setup-period-controls">
              <div className="display-setup-segmented" role="radiogroup" aria-label="Reporting week">
                {(["this_week", "last_week"] as ReportWeek[]).map((w) => (
                  <label key={w} className={draft.reportWeek === w ? "selected" : ""}>
                    <input
                      type="radio"
                      name="report-week"
                      checked={draft.reportWeek === w}
                      onChange={() => setDraft({ ...draft, reportWeek: w })}
                    />
                    {w === "this_week" ? "This week" : "Last week"}
                  </label>
                ))}
              </div>
              <label className="display-setup-checkbox">
                <input
                  type="checkbox"
                  checked={draft.reportIncludeToday}
                  disabled={draft.reportWeek === "last_week"}
                  onChange={(e) => setDraft({ ...draft, reportIncludeToday: e.target.checked })}
                />
                Include today
              </label>
              <label className="display-setup-inline-field">
                Map slide
                <input
                  type="number"
                  min={5}
                  max={600}
                  value={draft.mapSlideSeconds}
                  onChange={(e) => setDraft({ ...draft, mapSlideSeconds: e.target.value })}
                />
                s
              </label>
            </div>
            {period && (
              <p className="display-setup-period">
                {period.empty
                  ? "No days yet this week without today — the TV shows only the map until tomorrow."
                  : `Rankings cover ${formatDateLong(period.dateStart)}${period.dateStart === period.dateEnd ? "" : ` – ${formatDateLong(period.dateEnd)}`} (weeks start Monday, organization time zone).`}
              </p>
            )}
          </section>

          <section className="display-setup-section">
            <h2>
              Activities <span className="display-setup-count">{sentCount} sent to TV</span>
            </h2>
            <div className="display-setup-cards">
              {draft.activities.map((a) => (
                <div key={a.activityId} className={`display-setup-card${a.sendToTv ? " sent" : ""}`}>
                  <div className="display-setup-card-head">
                    <h3>{a.name}</h3>
                    <label className="display-setup-checkbox display-setup-send">
                      <input type="checkbox" checked={a.sendToTv} onChange={(e) => updateActivity(a.activityId, { sendToTv: e.target.checked })} />
                      Send to TV
                    </label>
                  </div>
                  <p className="display-setup-unit">
                    {a.densitySource
                      ? `Speed: ${a.speedUnit ?? `${a.densitySource}/hour`}`
                      : "No speed calculation for this activity (no stems or plants count per row) — its slide shows a notice instead of rankings."}
                  </p>
                  <div className={`display-setup-card-fields${a.sendToTv ? "" : " muted"}`}>
                    <label>
                      Target
                      <input
                        type="number"
                        min={0}
                        step="any"
                        placeholder={a.normalSpeed != null ? `${a.normalSpeed} (normal speed)` : "None"}
                        value={a.targetText}
                        onChange={(e) => updateActivity(a.activityId, { targetText: e.target.value })}
                      />
                    </label>
                    <label>
                      Min. activity hours
                      <input
                        type="number"
                        min={0}
                        max={168}
                        step={0.25}
                        value={a.minHoursText}
                        onChange={(e) => updateActivity(a.activityId, { minHoursText: e.target.value })}
                      />
                    </label>
                    <label>
                      Show
                      <span className="display-setup-topn">
                        <select
                          value={a.topNText === "" ? "all" : "top"}
                          onChange={(e) => updateActivity(a.activityId, { topNText: e.target.value === "all" ? "" : a.topNText || "10" })}
                        >
                          <option value="all">All</option>
                          <option value="top">Top N</option>
                        </select>
                        {a.topNText !== "" && (
                          <input
                            type="number"
                            min={1}
                            max={200}
                            aria-label={`Top N for ${a.name}`}
                            value={a.topNText}
                            onChange={(e) => updateActivity(a.activityId, { topNText: e.target.value })}
                          />
                        )}
                      </span>
                    </label>
                    <label>
                      Slide duration (s)
                      <input
                        type="number"
                        min={5}
                        max={600}
                        value={a.secondsText}
                        onChange={(e) => updateActivity(a.activityId, { secondsText: e.target.value })}
                      />
                    </label>
                  </div>
                  {a.targetText === "" && a.normalSpeed != null && (
                    <p className="display-setup-hint">Target uses the activity's normal speed. Enter a number to override it on this TV only.</p>
                  )}
                </div>
              ))}
            </div>
          </section>

          <div className="display-setup-actions">
            <button type="button" className="employees-add-button" disabled={!isDirty || saving} onClick={handleSave}>
              <Save size={16} aria-hidden="true" />
              {saving ? "Saving..." : "Save TV settings"}
            </button>
            {saveError && <p className="error-text">{saveError}</p>}
            {saveSuccess && <p className="success-text">Saved. The TV picks this up within a minute.</p>}
          </div>
        </>
      )}
    </div>
  );
}
