import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Clock, EyeOff, Save } from "lucide-react";
import { useUnsavedChangesGuard } from "../../context/UnsavedChangesContext";
import { api, ApiError } from "../../lib/api";
import { reportingPeriodFor } from "../../lib/displaySlideshow";
import { DAY_SHORT, endsNextDay, SlideSchedule, summarizeSchedule } from "../../lib/displaySchedule";
import {
  ActivitySlideSetting,
  DisplaySlidesConfig,
  GreenhouseDisplaySummary,
  ReportWeek,
} from "../../lib/greenhouseLiveTypes";
import { formatDateLong, todayInAppTimezone } from "../../lib/timezone";

// Display > Setup: which slides this TV shows — the map, and one employee
// speed-ranking slide per activity — when (an optional weekly schedule per
// slide, in the organization's time zone), and over which reporting period.
// Settings are per display, so two TVs can show different slides. The map's
// phases, dates, rotation and land stay on Display > Map. Hiding a card only
// tidies this page; it never changes what the TV shows.

interface Draft {
  reportWeek: ReportWeek;
  reportIncludeToday: boolean;
  mapSlideSeconds: string;
  mapSendToTv: boolean;
  mapSchedule: SlideSchedule;
  activities: (ActivitySlideSetting & { targetText: string; minHoursText: string; topNText: string; secondsText: string })[];
}

const MAP_CARD = "map";

function toDraft(config: DisplaySlidesConfig): Draft {
  return {
    reportWeek: config.reportWeek,
    reportIncludeToday: config.reportIncludeToday,
    mapSlideSeconds: String(config.mapSlideSeconds),
    mapSendToTv: config.map.sendToTv,
    mapSchedule: config.map.schedule,
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
    d.mapSendToTv,
    d.mapSchedule,
    d.activities.map((a) => [
      a.activityId,
      a.sendToTv,
      a.targetText,
      a.minHoursText,
      a.topNText,
      a.secondsText,
      a.atTargetColor,
      a.belowTargetColor,
      a.schedule,
    ]),
  ]);
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

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
  const [timezone, setTimezone] = useState("");
  // Hidden cards are saved on their own, at once — never part of the draft.
  const [hiddenCards, setHiddenCards] = useState<string[]>([]);
  const [hideError, setHideError] = useState<string | null>(null);
  // Which card's schedule is open: MAP_CARD or an activity id.
  const [scheduleFor, setScheduleFor] = useState<string | null>(null);

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
    setHideError(null);
    setScheduleFor(null);
    api<DisplaySlidesConfig>(`/api/greenhouse/displays/${id}/slides-config`)
      .then((config) => {
        const d = toDraft(config);
        setSaved(d);
        setDraft(d);
        setHiddenCards(config.hiddenCards ?? []);
        setTimezone(config.timezone ?? "");
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

  function scheduleOf(card: string): SlideSchedule | null {
    if (!draft) return null;
    if (card === MAP_CARD) return draft.mapSchedule;
    return draft.activities.find((a) => a.activityId === card)?.schedule ?? null;
  }

  function setScheduleOf(card: string, schedule: SlideSchedule) {
    if (card === MAP_CARD) setDraft((d) => (d ? { ...d, mapSchedule: schedule } : d));
    else updateActivity(card, { schedule });
  }

  async function saveHidden(next: string[]) {
    if (!displayId) return;
    const previous = hiddenCards;
    setHiddenCards(next);
    setHideError(null);
    try {
      const res = await api<{ hiddenCards: string[] }>(`/api/greenhouse/displays/${displayId}/setup-hidden-cards`, {
        method: "PUT",
        body: JSON.stringify({ hiddenCards: next }),
      });
      setHiddenCards(res.hiddenCards);
    } catch {
      setHiddenCards(previous);
      setHideError("Could not save which cards are hidden.");
    }
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
      if (!HEX_COLOR.test(a.atTargetColor) || !HEX_COLOR.test(a.belowTargetColor)) return `${a.name}: bar colours must be hex colours.`;
      if (a.schedule.enabled && a.schedule.days.length === 0) return `${a.name}: choose at least one day for the schedule.`;
      activities.push({
        activityId: a.activityId,
        sendToTv: a.sendToTv,
        targetOverride: target,
        minimumActivityHours: minHours,
        topN,
        slideSeconds: seconds,
        atTargetColor: a.atTargetColor,
        belowTargetColor: a.belowTargetColor,
        schedule: a.schedule,
      });
    }
    if (d.mapSchedule.enabled && d.mapSchedule.days.length === 0) return "Map: choose at least one day for the schedule.";
    return {
      reportWeek: d.reportWeek,
      reportIncludeToday: d.reportIncludeToday,
      mapSlideSeconds: mapSeconds,
      map: { sendToTv: d.mapSendToTv, schedule: d.mapSchedule },
      activities,
    };
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
  const hiddenSet = new Set(hiddenCards);
  const hiddenStillSent = draft
    ? (hiddenSet.has(MAP_CARD) && draft.mapSendToTv ? 1 : 0) +
      draft.activities.filter((a) => hiddenSet.has(a.activityId) && a.sendToTv).length
    : 0;
  const hiddenCount = draft ? (hiddenSet.has(MAP_CARD) ? 1 : 0) + draft.activities.filter((a) => hiddenSet.has(a.activityId)).length : 0;

  // Clock + Hide, the same on every card.
  function cardTools(card: string, name: string, schedule: SlideSchedule) {
    return (
      <div className="display-setup-card-tools">
        <button
          type="button"
          className={`display-setup-icon-button${schedule.enabled ? " scheduled" : ""}`}
          aria-label={`Schedule for ${name}`}
          title={schedule.enabled ? `Scheduled: ${summarizeSchedule(schedule)}` : "Always shown — click to schedule"}
          onClick={() => setScheduleFor(card)}
        >
          <Clock size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="display-setup-hide-button"
          aria-label={`Hide ${name}`}
          aria-describedby="display-setup-hide-note"
          onClick={() => saveHidden([...hiddenCards.filter((c) => c !== card), card])}
        >
          <EyeOff size={14} aria-hidden="true" />
          Hide
        </button>
        <span className="display-setup-hide-hint">Page only — TV unaffected</span>
      </div>
    );
  }

  function scheduleLine(schedule: SlideSchedule) {
    return (
      <p className={`display-setup-schedule-line${schedule.enabled ? " scheduled" : ""}`}>
        <Clock size={13} aria-hidden="true" /> {summarizeSchedule(schedule)}
      </p>
    );
  }

  return (
    <div className="display-setup-page">
      <div className="display-setup-header">
        <div>
          <h1>Display setup</h1>
          <p className="display-setup-subtitle">
            Choose which slides this TV shows — the map and employee speed rankings per activity — and when. The{" "}
            <Link to="/display/map">map</Link>'s phases, dates, rotation and land are set on Display → Map. With no slide
            scheduled, the TV says so and resumes on its own when a schedule starts.
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
            </div>
            {period && (
              <p className="display-setup-period">
                {period.empty
                  ? "No days yet this week without today — no ranking slides until tomorrow."
                  : `Rankings cover ${formatDateLong(period.dateStart)}${period.dateStart === period.dateEnd ? "" : ` – ${formatDateLong(period.dateEnd)}`} (weeks start Monday, organization time zone).`}
              </p>
            )}
          </section>

          <section className="display-setup-section">
            <div className="display-setup-section-head">
              <h2>
                Slides <span className="display-setup-count">{sentCount} sent to TV</span>
              </h2>
              {hiddenCount > 0 && (
                <div className="display-setup-hidden-bar">
                  <span>
                    {hiddenCount} hidden on this page
                    {hiddenStillSent > 0 ? ` (${hiddenStillSent} still sent to TV)` : ""}
                  </span>
                  <button type="button" className="display-setup-unhide" onClick={() => saveHidden([])}>
                    Unhide all
                  </button>
                </div>
              )}
            </div>
            <p id="display-setup-hide-note" className="display-setup-hint">
              Hide only tidies this page. A hidden card keeps its Send to TV setting and schedule, so the TV is unaffected.
            </p>
            {hideError && <p className="error-text">{hideError}</p>}
            <div className="display-setup-cards">
              {!hiddenSet.has(MAP_CARD) && (
                <div className={`display-setup-card display-setup-map-card${draft.mapSendToTv ? " sent" : ""}`}>
                  <div className="display-setup-card-head">
                    <h3>Map</h3>
                    <label className="display-setup-checkbox display-setup-send">
                      <input type="checkbox" checked={draft.mapSendToTv} onChange={(e) => setDraft({ ...draft, mapSendToTv: e.target.checked })} />
                      Send to TV
                    </label>
                  </div>
                  {cardTools(MAP_CARD, "Map", draft.mapSchedule)}
                  {scheduleLine(draft.mapSchedule)}
                  <p className="display-setup-unit">
                    The live greenhouse map. Phases, dates, rotation and land are set on <Link to="/display/map">Display → Map</Link>.
                  </p>
                  <div className={`display-setup-card-fields${draft.mapSendToTv ? "" : " muted"}`}>
                    <label>
                      Slide duration (s)
                      <input
                        type="number"
                        min={5}
                        max={600}
                        value={draft.mapSlideSeconds}
                        onChange={(e) => setDraft({ ...draft, mapSlideSeconds: e.target.value })}
                      />
                    </label>
                  </div>
                </div>
              )}
              {draft.activities.filter((a) => !hiddenSet.has(a.activityId)).map((a) => (
                <div key={a.activityId} className={`display-setup-card${a.sendToTv ? " sent" : ""}`}>
                  <div className="display-setup-card-head">
                    <h3>{a.name}</h3>
                    <label className="display-setup-checkbox display-setup-send">
                      <input type="checkbox" checked={a.sendToTv} onChange={(e) => updateActivity(a.activityId, { sendToTv: e.target.checked })} />
                      Send to TV
                    </label>
                  </div>
                  {cardTools(a.activityId, a.name, a.schedule)}
                  {scheduleLine(a.schedule)}
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
                      At/above target colour
                      <input
                        type="color"
                        className="display-setup-color"
                        value={a.atTargetColor}
                        onChange={(e) => updateActivity(a.activityId, { atTargetColor: e.target.value })}
                      />
                    </label>
                    <label>
                      Below target colour
                      <input
                        type="color"
                        className="display-setup-color"
                        value={a.belowTargetColor}
                        onChange={(e) => updateActivity(a.activityId, { belowTargetColor: e.target.value })}
                      />
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

          {scheduleFor && scheduleOf(scheduleFor) && (
            <ScheduleDialog
              name={scheduleFor === MAP_CARD ? "Map" : draft.activities.find((a) => a.activityId === scheduleFor)?.name ?? ""}
              schedule={scheduleOf(scheduleFor)!}
              timezone={timezone}
              onChange={(next) => setScheduleOf(scheduleFor, next)}
              onClose={() => setScheduleFor(null)}
            />
          )}

          <div className="display-setup-actions">
            <button type="button" className="employees-add-button" disabled={!isDirty || saving} onClick={handleSave}>
              <Save size={16} aria-hidden="true" />
              {saving ? "Saving..." : "Save TV settings"}
            </button>
            {saveError && <p className="error-text">{saveError}</p>}
            {saveSuccess && <p className="success-text">Saved. The TV picks this up within a minute — no refresh needed.</p>}
          </div>
        </>
      )}
    </div>
  );
}

// The schedule for one card. Edits go into the page's draft and are saved
// with "Save TV settings", like every other card setting.
function ScheduleDialog({
  name,
  schedule,
  timezone,
  onChange,
  onClose,
}: {
  name: string;
  schedule: SlideSchedule;
  timezone: string;
  onChange: (next: SlideSchedule) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggleDay = (day: number) =>
    onChange({
      ...schedule,
      days: schedule.days.includes(day) ? schedule.days.filter((d) => d !== day) : [...schedule.days, day].sort((a, b) => a - b),
    });

  return (
    <div className="display-setup-dialog-backdrop" onClick={onClose}>
      <div
        className="display-setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Schedule for ${name}`}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Schedule — {name}</h3>
        <div className="display-setup-segmented" role="radiogroup" aria-label="When to show this slide">
          <label className={!schedule.enabled ? "selected" : ""}>
            <input type="radio" name="schedule-mode" checked={!schedule.enabled} onChange={() => onChange({ ...schedule, enabled: false })} />
            Always show
          </label>
          <label className={schedule.enabled ? "selected" : ""}>
            <input type="radio" name="schedule-mode" checked={schedule.enabled} onChange={() => onChange({ ...schedule, enabled: true })} />
            Use schedule
          </label>
        </div>
        <fieldset className="display-setup-schedule-fields" disabled={!schedule.enabled}>
          <legend>Days</legend>
          <div className="display-setup-days">
            {DAY_SHORT.map((label, i) => (
              <label key={label} className={schedule.days.includes(i + 1) ? "selected" : ""}>
                <input type="checkbox" checked={schedule.days.includes(i + 1)} onChange={() => toggleDay(i + 1)} />
                {label}
              </label>
            ))}
          </div>
          <div className="display-setup-days-presets">
            <button type="button" onClick={() => onChange({ ...schedule, days: [1, 2, 3, 4, 5] })}>
              Mon–Fri
            </button>
            <button type="button" onClick={() => onChange({ ...schedule, days: [1, 2, 3, 4, 5, 6, 7] })}>
              Every day
            </button>
          </div>
          <div className="display-setup-times">
            <label>
              Start
              <input type="time" value={schedule.start} onChange={(e) => e.target.value && onChange({ ...schedule, start: e.target.value })} />
            </label>
            <label>
              End
              <input type="time" value={schedule.end} onChange={(e) => e.target.value && onChange({ ...schedule, end: e.target.value })} />
            </label>
          </div>
          {schedule.enabled && endsNextDay(schedule) && (
            <p className="display-setup-hint">
              {schedule.start === schedule.end
                ? "Start and end are the same: the slide shows for 24 hours from the start on each chosen day."
                : "Ends the next day: the slide shows from the start on each chosen day until the end time the following morning."}
            </p>
          )}
          {schedule.enabled && schedule.days.length === 0 && <p className="error-text">Choose at least one day.</p>}
        </fieldset>
        <p className="display-setup-hint">
          Times are in the organization's time zone{timezone ? ` (${timezone})` : ""}. The slide still needs Send to TV, and an
          activity slide still needs work in the reporting period.
        </p>
        <p className="display-setup-schedule-summary">{summarizeSchedule(schedule)}</p>
        <div className="display-setup-dialog-actions">
          <button type="button" className="employees-add-button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
