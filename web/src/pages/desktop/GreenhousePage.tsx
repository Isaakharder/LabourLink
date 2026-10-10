import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, Link2, MonitorUp, Plus } from "lucide-react";
import { GreenhouseLiveCanvas } from "../../components/greenhouseLive/GreenhouseLiveCanvas";
import { EmployeeBlockLegend } from "../../components/greenhouseLive/EmployeeBlockLegend";
import { GreenhouseLiveToolbar } from "../../components/greenhouseLive/GreenhouseLiveToolbar";
import { DateRangeCalendar } from "../../components/greenhouseLive/DateRangeCalendar";
import { RegenerateTvLinkModal } from "../../components/greenhouseLive/RegenerateTvLinkModal";
import { useAuth } from "../../context/AuthContext";
import { useUnsavedChangesGuard } from "../../context/UnsavedChangesContext";
import { api, ApiError } from "../../lib/api";
import { CanvasTransform, RotationDegrees, computeFitTransformToPhases, nextRotation, zoomAtPoint } from "../../lib/canvasTransform";
import {
  AvailableActivity,
  GreenhouseDisplayCreateResponse,
  GreenhouseDisplayRegenerateResponse,
  GreenhouseDisplaySummary,
  LiveGreenhouseResponse,
  LivePhase,
  isMapDatePreset,
} from "../../lib/greenhouseLiveTypes";
import { GreenhouseLandListItem } from "../../lib/greenhouseLayoutTypes";
import {
  addCalendarDays,
  endOfMonth,
  formatDateLong,
  startOfMonth,
  startOfWeekMonday,
  todayInAppTimezone,
} from "../../lib/timezone";

type DateRange = { start: string; end: string };

const ZOOM_BUTTON_FACTOR = 1.2;
const PREVIEW_POLL_INTERVAL_MS = 12000;
const LAST_LAND_KEY = "labourlink_greenhouse_live_land_id";

function formatRangeLabel(range: DateRange): string {
  return range.start === range.end
    ? formatDateLong(range.start)
    : `${formatDateLong(range.start)} – ${formatDateLong(range.end)}`;
}

// Comparable form of a phase selection: null (all phases) vs a sorted list.
function phaseSelectionKey(ids: string[] | null): string {
  return ids === null ? "all" : [...ids].sort().join(",");
}

// "All phases" / "Phase 1, Phase 3" for the published-status line.
function publishedPhasesLabel(ids: string[] | null, phases: LivePhase[]): string {
  if (ids === null) return "All phases";
  const names = phases.filter((p) => ids.includes(p.id)).map((p) => p.name);
  return names.length > 0 ? names.join(", ") : `${ids.length} phase${ids.length === 1 ? "" : "s"}`;
}

function todayRange(): DateRange {
  const today = todayInAppTimezone();
  return { start: today, end: today };
}

export function GreenhousePage() {
  const { employee } = useAuth();
  const isAdmin = employee?.securityRole === "Administrator";
  const { setUnsavedChanges } = useUnsavedChangesGuard();

  // --- Published displays (what the TV actually shows right now) ---
  const [displays, setDisplays] = useState<GreenhouseDisplaySummary[] | null>(null);
  const [selectedDisplayId, setSelectedDisplayId] = useState<string | null>(null);
  const selectedDisplay = displays?.find((d) => d.id === selectedDisplayId) ?? null;

  const [showNewDisplayForm, setShowNewDisplayForm] = useState(false);
  const [newDisplayName, setNewDisplayName] = useState("");
  const [creatingDisplay, setCreatingDisplay] = useState(false);
  const [createDisplayError, setCreateDisplayError] = useState<string | null>(null);
  // The TV link box (label + read-only URL + Copy/Open) is driven entirely
  // by selectedDisplay.tvToken — persisted server-side (see
  // greenhouseLiveTypes.ts's own comment), so it stays visible the same way
  // on first creation, after a regenerate, and on returning to this page
  // later. No separate "shown once" reveal state needed anymore.
  const [showRegenerateConfirm, setShowRegenerateConfirm] = useState(false);
  const [generatingLink, setGeneratingLink] = useState(false);
  const [generateLinkError, setGenerateLinkError] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  // --- Draft state (the office's own preview — nothing here reaches the
  // TV until Save/Publish) ---
  const [lands, setLands] = useState<GreenhouseLandListItem[] | null>(null);
  const [landId, setLandId] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<DateRange>(todayRange());
  const [preset, setPreset] = useState("today");
  const [activityFilterId, setActivityFilterId] = useState<string | null>(null);
  const [availableActivities, setAvailableActivities] = useState<AvailableActivity[] | null>(null);
  const [activityResetMessage, setActivityResetMessage] = useState<string | null>(null);
  // Phases the TV map shows — published per display. null = every phase of
  // the land (including phases added later); a list = exactly those. An
  // empty list is a draft-only state that can't be published.
  const [phaseIds, setPhaseIds] = useState<string[] | null>(null);
  const [rotationDegrees, setRotationDegrees] = useState<RotationDegrees>(0);
  const initializedFromDisplayRef = useRef<string | null>(null);

  // --- Live preview data ---
  const [data, setData] = useState<LiveGreenhouseResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- Save/Publish ---
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const [transform, setTransform] = useState<CanvasTransform>({ pan: { x: 0, y: 0 }, scale: 1 });
  const [fitScale, setFitScale] = useState(1);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const autoFitKeyRef = useRef<string | null>(null);

  const isDirty = Boolean(
    selectedDisplay &&
      (selectedDisplay.landId !== landId ||
        (selectedDisplay.activityId ?? null) !== activityFilterId ||
        (selectedDisplay.datePreset ?? "custom") !== preset ||
        selectedDisplay.effectiveDateStart !== dateRange.start ||
        selectedDisplay.effectiveDateEnd !== dateRange.end ||
        selectedDisplay.rotationDegrees !== rotationDegrees ||
        phaseSelectionKey(selectedDisplay.phaseIds ?? null) !== phaseSelectionKey(phaseIds))
  );

  // Lands reuse the existing editor-facing endpoint — read-only here.
  useEffect(() => {
    api<{ lands: GreenhouseLandListItem[] }>("/api/greenhouse-layout/lands")
      .then((res) => {
        setLands(res.lands);
        if (!landId) {
          const remembered = localStorage.getItem(LAST_LAND_KEY);
          const active = res.lands.filter((l) => l.isActive);
          const initial =
            (remembered && res.lands.find((l) => l.id === remembered)?.id) ||
            active[0]?.id ||
            res.lands[0]?.id ||
            null;
          setLandId(initial ?? null);
          if (!initial) setLoading(false);
        }
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "Could not load greenhouse lands");
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadDisplays = useCallback(() => {
    api<{ displays: GreenhouseDisplaySummary[] }>("/api/greenhouse/displays")
      .then((res) => {
        setDisplays(res.displays);
        setSelectedDisplayId((prev) => prev ?? res.displays.find((d) => d.isActive)?.id ?? res.displays[0]?.id ?? null);
      })
      .catch(() => {
        // Non-fatal — the map preview still works without any display
        // configured yet; only Save/Publish needs one to target.
      });
  }, []);

  useEffect(() => {
    loadDisplays();
  }, [loadDisplays]);

  // The office page opens already showing what's currently published, not
  // an arbitrary default — draft state is seeded from the selected
  // display's config exactly once per display selection, never overwritten
  // by a later background refresh of `displays` (which would otherwise wipe
  // out in-progress unsaved edits every time loadDisplays() re-runs).
  useEffect(() => {
    if (!selectedDisplay || initializedFromDisplayRef.current === selectedDisplay.id) return;
    initializedFromDisplayRef.current = selectedDisplay.id;
    setLandId(selectedDisplay.landId);
    // A relative preset reopens as that preset, showing what the TV shows
    // today; fixed dates (every display published before presets existed)
    // reopen as the exact custom range.
    setDateRange({ start: selectedDisplay.effectiveDateStart, end: selectedDisplay.effectiveDateEnd });
    setActivityFilterId(selectedDisplay.activityId);
    setRotationDegrees(selectedDisplay.rotationDegrees);
    setPreset(selectedDisplay.datePreset ?? "custom");
    setPhaseIds(selectedDisplay.phaseIds ?? null);
  }, [selectedDisplay]);

  useEffect(() => {
    if (landId) localStorage.setItem(LAST_LAND_KEY, landId);
  }, [landId]);

  // Available activities: server-derived, only ever activities with
  // qualifying work in the current land/range — refetched whenever either
  // changes. If the previously selected activity no longer qualifies,
  // reset to "All activities" with a short explanation rather than
  // silently keeping a now-invalid filter.
  useEffect(() => {
    if (!landId) return;
    const params = new URLSearchParams({ landId, dateStart: dateRange.start, dateEnd: dateRange.end });
    api<{ activities: AvailableActivity[] }>(`/api/greenhouse/available-activities?${params.toString()}`)
      .then((res) => {
        setAvailableActivities(res.activities);
        if (activityFilterId && !res.activities.some((a) => a.id === activityFilterId)) {
          setActivityFilterId(null);
          setActivityResetMessage("The previously selected activity has no work in this range — showing all activities.");
        } else {
          setActivityResetMessage(null);
        }
      })
      .catch(() => setAvailableActivities([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landId, dateRange.start, dateRange.end]);

  const loadPreview = useCallback(
    (background: boolean) => {
      if (!landId) return;
      if (background) setRefreshing(true);
      const params = new URLSearchParams({
        landId,
        dateStart: dateRange.start,
        dateEnd: dateRange.end,
      });
      if (activityFilterId) params.set("activityId", activityFilterId);
      // Narrows only the employee-block legend; every phase still comes back.
      if (phaseIds && phaseIds.length > 0) params.set("phaseIds", phaseIds.join(","));
      api<LiveGreenhouseResponse>(`/api/greenhouse/live?${params.toString()}`)
        .then((res) => {
          setData(res);
          setError(null);
        })
        .catch((err) => {
          // Keep last-good data on screen — a transient poll failure
          // shouldn't blank out a map someone's actively watching.
          setError(err instanceof ApiError ? err.message : "Could not load live greenhouse state");
        })
        .finally(() => {
          setLoading(false);
          setRefreshing(false);
        });
    },
    [landId, dateRange.start, dateRange.end, activityFilterId, phaseIds]
  );

  useEffect(() => {
    if (!landId) return;
    setLoading(true);
    loadPreview(false);
  }, [landId, dateRange.start, dateRange.end, activityFilterId, loadPreview]);

  useEffect(() => {
    if (!landId) return;
    const interval = window.setInterval(() => loadPreview(true), PREVIEW_POLL_INTERVAL_MS);
    function onFocus() {
      loadPreview(true);
    }
    function onVisibilityChange() {
      if (document.visibilityState === "visible") loadPreview(true);
    }
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [landId, loadPreview]);

  // Warn before a hard reload/tab-close/external navigation with unsaved
  // changes. In-app SPA navigation (sidebar links, etc.) cannot be blocked
  // this way — this repo uses a plain BrowserRouter, and useBlocker/
  // unstable_usePrompt require a data router, a separate larger change.
  useEffect(() => {
    function handler(e: BeforeUnloadEvent) {
      if (!isDirty) return;
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  // In-app counterpart for the sidebar's own navigation links and Sign Out
  // (see UnsavedChangesContext) — beforeunload above only covers a hard
  // reload/tab-close/external navigation. Cleared on unmount so leaving this
  // page (by any means) never leaves a stale "dirty" flag guarding some
  // other, unrelated page's navigation afterward.
  useEffect(() => {
    setUnsavedChanges(isDirty, `Unsaved changes to ${selectedDisplay?.name ?? "this display"} will be lost. Leave without publishing?`);
    return () => setUnsavedChanges(false);
  }, [isDirty, selectedDisplay, setUnsavedChanges]);

  function applyPreset(value: string) {
    setPreset(value);
    const today = todayInAppTimezone();
    if (value === "today") setDateRange({ start: today, end: today });
    else if (value === "yesterday") {
      const y = addCalendarDays(today, -1);
      setDateRange({ start: y, end: y });
    } else if (value === "thisWeek") {
      const s = startOfWeekMonday(today);
      setDateRange({ start: s, end: addCalendarDays(s, 6) });
    } else if (value === "lastWeek") {
      const s = addCalendarDays(startOfWeekMonday(today), -7);
      setDateRange({ start: s, end: addCalendarDays(s, 6) });
    } else if (value === "last7") {
      setDateRange({ start: addCalendarDays(today, -6), end: today });
    } else if (value === "thisMonth") {
      setDateRange({ start: startOfMonth(today), end: endOfMonth(today) });
    } else if (value === "lastMonth") {
      const lastMonthDay = addCalendarDays(startOfMonth(today), -1);
      setDateRange({ start: startOfMonth(lastMonthDay), end: lastMonthDay });
    }
    // "custom" — no-op, the calendar itself drives dateRange from here.
  }

  function handleCalendarChange(range: DateRange) {
    setDateRange(range);
    setPreset("custom");
  }

  async function handleSave() {
    if (!selectedDisplay || !landId) return;
    if (noPhaseSelected) {
      setSaveError("Select at least one phase to publish.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    try {
      const res = await api<{ display: GreenhouseDisplaySummary }>(`/api/greenhouse/displays/${selectedDisplay.id}`, {
        method: "PUT",
        body: JSON.stringify({
          landId,
          activityId: activityFilterId,
          dateStart: dateRange.start,
          dateEnd: dateRange.end,
          rotationDegrees,
          // A preset keeps advancing on the TV; "custom" publishes fixed dates.
          datePreset: isMapDatePreset(preset) ? preset : null,
          phaseIds: phaseIds === null ? null : selectedPhaseIds,
        }),
      });
      setDisplays((prev) => prev?.map((d) => (d.id === res.display.id ? res.display : d)) ?? [res.display]);
      setSaveSuccess(true);
      window.setTimeout(() => setSaveSuccess(false), 4000);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Could not publish to the TV");
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateDisplay() {
    if (!newDisplayName.trim() || !landId) return;
    setCreatingDisplay(true);
    setCreateDisplayError(null);
    try {
      const res = await api<GreenhouseDisplayCreateResponse>("/api/greenhouse/displays", {
        method: "POST",
        body: JSON.stringify({ name: newDisplayName.trim(), landId }),
      });
      setDisplays((prev) => [...(prev ?? []), res.display]);
      setSelectedDisplayId(res.display.id);
      initializedFromDisplayRef.current = null;
      setShowNewDisplayForm(false);
      setNewDisplayName("");
    } catch (err) {
      setCreateDisplayError(err instanceof ApiError ? err.message : "Could not create this display");
    } finally {
      setCreatingDisplay(false);
    }
  }

  function tvUrlFor(token: string): string {
    return `${window.location.origin}/greenhouse/display/${token}`;
  }

  // Clipboard access can silently fail (insecure context, missing
  // permission, an older/kiosk browser) — this is never the only way to
  // get the URL, just a convenience on top of the always-visible TV link
  // field + its own Copy button below.
  async function copyTvUrl(token: string) {
    try {
      await navigator.clipboard.writeText(tvUrlFor(token));
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 3000);
    } catch {
      setLinkCopied(false);
    }
  }

  // Every selected display already has an active TV link the instant it's
  // created (POST /api/greenhouse/displays mints one immediately) — so this
  // button is always effectively a *regenerate*, and always needs the same
  // explicit, informed confirmation: it immediately invalidates whatever
  // link is currently open on a TV, whether or not that link happens to be
  // visible here right now (see GreenhouseDisplaySummary.tvToken's own
  // comment for when it can be null).
  function handleGenerateTvLink() {
    if (!selectedDisplay) return;
    setGenerateLinkError(null);
    setShowRegenerateConfirm(true);
  }

  async function confirmRegenerateTvLink() {
    if (!selectedDisplay) return;
    setGeneratingLink(true);
    setGenerateLinkError(null);
    try {
      const res = await api<GreenhouseDisplayRegenerateResponse>(
        `/api/greenhouse/displays/${selectedDisplay.id}/regenerate-key`,
        { method: "POST" }
      );
      setDisplays((prev) => prev?.map((d) => (d.id === selectedDisplay.id ? { ...d, tvToken: res.token } : d)) ?? prev);
      setShowRegenerateConfirm(false);
    } catch (err) {
      setGenerateLinkError(err instanceof ApiError ? err.message : "Could not generate a new TV link");
    } finally {
      setGeneratingLink(false);
    }
  }

  // The current land's phases (the preview only ever returns active ones),
  // and which of them are checked. Ids no longer on this land are ignored.
  const landPhases: LivePhase[] = data?.land.phases ?? [];
  const selectedPhaseIds = phaseIds === null ? landPhases.map((p) => p.id) : landPhases.filter((p) => phaseIds.includes(p.id)).map((p) => p.id);
  const visiblePhases = phaseIds === null ? landPhases : landPhases.filter((p) => phaseIds.includes(p.id));
  const allPhasesSelected = landPhases.length > 0 && selectedPhaseIds.length === landPhases.length;
  const noPhaseSelected = data !== null && selectedPhaseIds.length === 0;

  function togglePhase(id: string) {
    const current = phaseIds ?? landPhases.map((p) => p.id);
    const next = current.includes(id) ? current.filter((p) => p !== id) : [...current, id];
    setPhaseIds(next.length === landPhases.length && landPhases.every((p) => next.includes(p.id)) ? null : next);
    setSaveError(null);
  }

  function toggleAllPhases(checked: boolean) {
    setPhaseIds(checked ? null : []);
    setSaveError(null);
  }

  const minScale = fitScale * 0.15;
  const maxScale = fitScale * 6;
  const zoomPercent = fitScale > 0 ? Math.round((transform.scale / fitScale) * 100) : 100;

  // Fits the CHECKED phases (their combined bounds, after rotation) into the
  // canvas — the same fit the TV applies to the phases it's given.
  function fitToScreen(width = viewportSize.width, height = viewportSize.height, rotation = rotationDegrees) {
    if (!data || width <= 0 || height <= 0) return;
    const fit = computeFitTransformToPhases(data.land, visiblePhases, width, height, rotation);
    setFitScale(fit.scale);
    setTransform(fit);
  }

  const visiblePhaseKey = visiblePhases.map((p) => p.id).join(",");
  function handleViewportSize(size: { width: number; height: number }) {
    setViewportSize(size);
    const key = data ? `${data.land.id}:${dateRange.start}:${dateRange.end}:${activityFilterId ?? "all"}:${visiblePhaseKey}` : null;
    if (data && key && autoFitKeyRef.current !== key && size.width > 0 && size.height > 0) {
      autoFitKeyRef.current = key;
      fitToScreen(size.width, size.height);
    }
  }

  // Checking/unchecking phases refits the preview to the new selection.
  useEffect(() => {
    if (!data || viewportSize.width <= 0 || viewportSize.height <= 0) return;
    const key = `${data.land.id}:${dateRange.start}:${dateRange.end}:${activityFilterId ?? "all"}:${visiblePhaseKey}`;
    if (autoFitKeyRef.current === key) return;
    autoFitKeyRef.current = key;
    fitToScreen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visiblePhaseKey, data?.land.id]);

  function zoomByFactor(factor: number) {
    const newScale = Math.min(maxScale, Math.max(minScale, transform.scale * factor));
    setTransform(zoomAtPoint(transform, newScale, viewportSize.width / 2, viewportSize.height / 2));
  }

  // Draft-only — never reaches the TV until Publish. Rotates 90° clockwise
  // per click (0 -> 90 -> 180 -> 270 -> 0) and immediately refits using the
  // *new* rotation, computed directly rather than read back from state
  // (which wouldn't have committed yet within this same handler).
  function handleRotate() {
    if (!data) return;
    const next = nextRotation(rotationDegrees);
    setRotationDegrees(next);
    fitToScreen(viewportSize.width, viewportSize.height, next);
  }

  return (
    <div className="greenhouse-office-page">
      <div className="greenhouse-office-layout">
        <div className="greenhouse-office-sidebar">
          <div className="greenhouse-office-section">
            <label className="greenhouse-office-field">
              Display
              <span className="greenhouse-office-select-wrap">
                <select
                  className="greenhouse-office-select"
                  value={selectedDisplayId ?? ""}
                  onChange={(e) => {
                    setSelectedDisplayId(e.target.value || null);
                    initializedFromDisplayRef.current = null;
                  }}
                  disabled={!displays || displays.length === 0}
                >
                  {(!displays || displays.length === 0) && <option value="">No displays yet</option>}
                  {displays?.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </span>
            </label>
            {isAdmin && (
              <button
                type="button"
                className="greenhouse-office-secondary-button"
                onClick={() => setShowNewDisplayForm((v) => !v)}
              >
                <Plus size={16} aria-hidden="true" />
                <span>New Display</span>
              </button>
            )}
          </div>

          {showNewDisplayForm && (
            <div className="greenhouse-office-section greenhouse-office-new-display">
              <input
                className="greenhouse-office-text-input"
                type="text"
                placeholder="e.g. Break Area TV"
                value={newDisplayName}
                onChange={(e) => setNewDisplayName(e.target.value)}
              />
              {createDisplayError && <p className="error-text">{createDisplayError}</p>}
              <div className="employee-form-actions">
                <button type="button" onClick={() => setShowNewDisplayForm(false)} disabled={creatingDisplay}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="employee-form-save"
                  onClick={handleCreateDisplay}
                  disabled={creatingDisplay || !newDisplayName.trim()}
                >
                  {creatingDisplay ? "Creating..." : "Create"}
                </button>
              </div>
            </div>
          )}

          {/* TV link — kept compact (one label, one field, two small
              buttons) so it doesn't crowd the date picker below it. Driven
              entirely by selectedDisplay.tvToken, so the same URL is still
              here on a later visit, not just right after generating it. */}
          {isAdmin && selectedDisplay && (
            <div className="greenhouse-office-section greenhouse-office-tv-link">
              <button
                type="button"
                className="greenhouse-office-secondary-button"
                onClick={handleGenerateTvLink}
                disabled={generatingLink}
              >
                <Link2 size={16} aria-hidden="true" />
                <span>{selectedDisplay.tvToken ? "Regenerate TV Link" : "Generate TV Link"}</span>
              </button>

              <span className="greenhouse-office-tv-link-label">TV link</span>
              {selectedDisplay.tvToken ? (
                <>
                  <input
                    className="greenhouse-office-tv-link-field"
                    type="text"
                    readOnly
                    value={tvUrlFor(selectedDisplay.tvToken)}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <div className="greenhouse-office-tv-link-actions">
                    <button
                      type="button"
                      className="greenhouse-office-secondary-button"
                      onClick={() => copyTvUrl(selectedDisplay.tvToken!)}
                    >
                      {linkCopied ? (
                        <>
                          <Check size={16} aria-hidden="true" />
                          <span>Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy size={16} aria-hidden="true" />
                          <span>Copy</span>
                        </>
                      )}
                    </button>
                    <a
                      className="greenhouse-office-secondary-button"
                      href={tvUrlFor(selectedDisplay.tvToken)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink size={16} aria-hidden="true" />
                      <span>Open</span>
                    </a>
                  </div>
                </>
              ) : (
                <p className="greenhouse-office-tv-link-missing">
                  This display's link was created before it could be shown here — regenerate to get a copyable one.
                </p>
              )}
            </div>
          )}

          {displays === null ? (
            // Guards against a real race: the "seed draft state from the
            // selected display's published config" effect (above) only
            // fires once `displays` has loaded. Rendering the date/publish
            // controls as interactive before that resolves would let a fast
            // click land on stale/default draft state that then gets
            // silently overwritten the instant the real config arrives.
            <p className="placeholder-page">Loading...</p>
          ) : (
            <>
              <div className="greenhouse-office-section">
                <label className="greenhouse-office-field">
                  Quick range
                  <span className="greenhouse-office-select-wrap">
                    <select className="greenhouse-office-select" value={preset} onChange={(e) => applyPreset(e.target.value)}>
                      <option value="today">Today</option>
                      <option value="yesterday">Yesterday</option>
                      <option value="thisWeek">This week</option>
                      <option value="lastWeek">Last week</option>
                      <option value="last7">Last 7 days</option>
                      <option value="thisMonth">This month</option>
                      <option value="lastMonth">Last month</option>
                      <option value="custom">Custom range (fixed dates)</option>
                    </select>
                  </span>
                </label>

                <DateRangeCalendar value={dateRange} onChange={handleCalendarChange} />

                <p className="greenhouse-office-range-label">{formatRangeLabel(dateRange)}</p>
                <p className="greenhouse-office-hint">
                  {isMapDatePreset(preset)
                    ? "The TV moves this range forward by itself each day — no need to republish."
                    : "Fixed dates: the TV keeps showing exactly these days until you publish again."}
                </p>
              </div>

              <fieldset className="greenhouse-office-section greenhouse-office-phases">
                <legend className="greenhouse-office-phases-legend">Phases on the TV map</legend>
                {!data ? (
                  <p className="greenhouse-office-hint">Loading phases…</p>
                ) : landPhases.length === 0 ? (
                  <p className="greenhouse-office-hint">This land has no active phases.</p>
                ) : (
                  <>
                    <label className="greenhouse-office-phase-option greenhouse-office-phase-all">
                      <input
                        type="checkbox"
                        checked={allPhasesSelected}
                        ref={(el) => {
                          if (el) el.indeterminate = !allPhasesSelected && selectedPhaseIds.length > 0;
                        }}
                        onChange={(e) => toggleAllPhases(e.target.checked)}
                      />
                      <span>Select all phases</span>
                    </label>
                    <div className="greenhouse-office-phase-list">
                      {landPhases.map((p) => (
                        <label key={p.id} className="greenhouse-office-phase-option">
                          <input type="checkbox" checked={selectedPhaseIds.includes(p.id)} onChange={() => togglePhase(p.id)} />
                          <span>{p.name}</span>
                        </label>
                      ))}
                    </div>
                    {noPhaseSelected && (
                      <p className="error-text" role="alert">
                        Select at least one phase to publish.
                      </p>
                    )}
                  </>
                )}
              </fieldset>

              <div className="greenhouse-office-section">
                <button
                  type="button"
                  className="employees-add-button greenhouse-office-publish-button"
                  disabled={!selectedDisplay || !isDirty || saving || noPhaseSelected}
                  onClick={handleSave}
                >
                  <MonitorUp size={16} aria-hidden="true" />
                  {saving ? "Publishing..." : "Publish to TV"}
                </button>
                {saveError && <p className="error-text">{saveError}</p>}
                {saveSuccess && <p className="success-text">Published to {selectedDisplay?.name}.</p>}
                {isDirty && !saving && (
                  <p className="greenhouse-office-unsaved-note">Unsaved changes — not yet visible on the TV.</p>
                )}
              </div>
            </>
          )}
        </div>

        <div className="greenhouse-office-main">
          <div className="greenhouse-office-toprow">
            <label className="greenhouse-office-field greenhouse-office-toprow-field">
              Activity
              <span className="greenhouse-office-select-wrap greenhouse-office-select-wide">
                <select
                  className="greenhouse-office-select"
                  value={activityFilterId ?? ""}
                  onChange={(e) => setActivityFilterId(e.target.value || null)}
                >
                  <option value="">All activities currently in use</option>
                  {availableActivities?.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </span>
            </label>
            {availableActivities?.length === 0 && (
              <p className="greenhouse-office-activity-note">No activities have recorded work in this range.</p>
            )}
            {activityResetMessage && <p className="greenhouse-office-activity-note">{activityResetMessage}</p>}

            <span className="greenhouse-office-published-status">
              {selectedDisplay
                ? `Published: ${selectedDisplay.activityName ?? "All activities"} · ${formatRangeLabel({
                    start: selectedDisplay.effectiveDateStart,
                    end: selectedDisplay.effectiveDateEnd,
                  })}${selectedDisplay.datePreset ? " (advances daily)" : ""} · ${publishedPhasesLabel(
                    selectedDisplay.phaseIds ?? null,
                    selectedDisplay.landId === data?.land.id ? landPhases : []
                  )}`
                : "No display selected"}
            </span>
          </div>

          {lands && lands.length > 1 && (
            <div className="greenhouse-live-land-bar">
              <label className="greenhouse-office-field greenhouse-office-land-field">
                Land
                <span className="greenhouse-office-select-wrap">
                  <select
                    className="greenhouse-office-select"
                    value={landId ?? ""}
                    onChange={(e) => {
                      setLandId(e.target.value);
                      // Phases belong to a land: a different land starts with all of its phases.
                      setPhaseIds(null);
                    }}
                  >
                    {lands.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </span>
              </label>
            </div>
          )}

          {error && <p className="error-text">{error}</p>}

          {loading ? (
            <p className="placeholder-page">Loading...</p>
          ) : !data ? (
            <p className="placeholder-page">No greenhouse land has been set up yet.</p>
          ) : (
            <div className="greenhouse-live-workspace">
              <GreenhouseLiveToolbar
                zoomPercent={zoomPercent}
                onZoomIn={() => zoomByFactor(ZOOM_BUTTON_FACTOR)}
                onZoomOut={() => zoomByFactor(1 / ZOOM_BUTTON_FACTOR)}
                onFitToScreen={() => fitToScreen()}
                onRotate={handleRotate}
                generatedAt={data.generatedAt}
                refreshing={refreshing}
                onRefresh={() => loadPreview(true)}
              />

              <div className="greenhouse-live-canvas-wrapper">
                <GreenhouseLiveCanvas
                  land={data.land}
                  phases={visiblePhases}
                  phaseFilterId={null}
                  transform={transform}
                  onTransformChange={setTransform}
                  onViewportSize={handleViewportSize}
                  minScale={minScale}
                  maxScale={maxScale}
                  rotationDegrees={rotationDegrees}
                  blocks={data.blocks}
                />
              </div>

              <div className="greenhouse-live-legend">
                <span>
                  <span className="greenhouse-live-legend-swatch greenhouse-live-row-blue" /> Working
                </span>
                <span>
                  <span className="greenhouse-live-legend-swatch greenhouse-live-row-green" /> Completed
                </span>
                <span>
                  <span className="greenhouse-live-legend-swatch greenhouse-live-row-neutral" /> No activity
                </span>
              </div>
              <EmployeeBlockLegend blocks={data.blocks} />
            </div>
          )}
        </div>
      </div>

      {showRegenerateConfirm && selectedDisplay && (
        <RegenerateTvLinkModal
          displayName={selectedDisplay.name}
          submitting={generatingLink}
          error={generateLinkError}
          onConfirm={confirmRegenerateTvLink}
          onCancel={() => {
            setShowRegenerateConfirm(false);
            setGenerateLinkError(null);
          }}
        />
      )}
    </div>
  );
}
