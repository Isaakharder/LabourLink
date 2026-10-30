import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  buildTimelineScale,
  computeBarPosition,
  computeFitAllPxPerDay,
  computeVacationPosition,
  describeTimelineEnd,
  MAX_PX_PER_DAY,
  percentInRange,
  pinnedYearLabel,
  rangeDayCount,
  TimelineRange,
} from "../../lib/employmentTimeline";
import { DATE_FIELD_LABELS, EmploymentTimelineEmployee, TIMELINE_BAR_LABEL_TEXT, TimelineBarLabel } from "../../lib/employmentPeriodTypes";

interface EmploymentTimelineGraphProps {
  // Already filtered, in displayed order — row n is numbered n.
  employees: EmploymentTimelineEmployee[];
  range: TimelineRange;
  today: string;
  canEdit: boolean;
  // Incremented by the Today button — this component scrolls the today
  // line into view in response.
  scrollToTodayToken: number;
  // Reported after every zoom-affecting change so the toolbar's +/-
  // buttons can disable themselves at the true limits.
  onZoomLimitsChange?: (canZoomIn: boolean, canZoomOut: boolean) => void;
  // Opens the employment-dates editor (read-only for a viewer who can't edit).
  onEditDates: (employee: EmploymentTimelineEmployee) => void;
}

export interface EmploymentTimelineGraphHandle {
  zoomIn(): void;
  zoomOut(): void;
  // Resets to the exact "entire range fits the available width" density.
  fitAll(): void;
}

function barStateClass(label: TimelineBarLabel): string {
  if (label === "completed") return "employment-timeline-bar-completed";
  if (label === "permitExpired") return "employment-timeline-bar-permit-expired";
  if (label === "ongoing") return "employment-timeline-bar-ongoing";
  return "employment-timeline-bar-current"; // "employed" — a real, future end date
}

const LEGEND: { className: string; label: string }[] = [
  { className: "employment-timeline-bar-current", label: "Employed (ends on End Different Date or permit expiry)" },
  { className: "employment-timeline-bar-ongoing", label: "Ongoing (no end date)" },
  { className: "employment-timeline-bar-permit-expired", label: "Permit expired" },
  { className: "employment-timeline-bar-completed", label: "Finished (End Different Date reached)" },
  { className: "employment-timeline-vacation", label: "Vacation (still employed)" },
];

function vacationText(emp: EmploymentTimelineEmployee): string {
  return `Vacation: ${emp.vacationStartDate} – ${emp.vacationEndDate}`;
}

function barTooltip(number: number, emp: EmploymentTimelineEmployee, clipped: boolean): string {
  const name = `${emp.firstName} ${emp.lastName}`;
  return [
    `${number}. ${name} — ${emp.timelineLabel ? TIMELINE_BAR_LABEL_TEXT[emp.timelineLabel] : ""}`,
    `${DATE_FIELD_LABELS.startDate}: ${emp.employmentStartDate}${clipped ? " (before the displayed range)" : ""}`,
    `${DATE_FIELD_LABELS.workPermitExpiryDate}: ${emp.workPermitExpiryDate ?? "—"}`,
    `${DATE_FIELD_LABELS.endDifferentDate}: ${emp.endDifferentDate ?? "—"}`,
    emp.vacationStartDate ? vacationText(emp) : null,
    `Timeline ends: ${describeTimelineEnd(emp)}`,
    emp.employmentType ? `Type: ${emp.employmentType}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

// Zoom step multiplier per click/wheel-notch.
const ZOOM_STEP_FACTOR = 1.6;
// Float drift guard when comparing densities.
const ZOOM_EPSILON = 0.001;

export const EmploymentTimelineGraph = forwardRef<EmploymentTimelineGraphHandle, EmploymentTimelineGraphProps>(function EmploymentTimelineGraph(
  { employees, range, today, canEdit, scrollToTodayToken, onZoomLimitsChange, onEditDates },
  ref
) {
  const rangeDays = rangeDayCount(range);

  const wrapRef = useRef<HTMLDivElement>(null);
  const [containerWidthPx, setContainerWidthPx] = useState(0);
  // Layout effect: measured before the first paint, so the very first frame
  // already uses the real width (no flash of a mis-scaled header).
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setContainerWidthPx(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return; // jsdom/older-browser fallback: static initial width only
    const observer = new ResizeObserver((entries) => setContainerWidthPx(entries[0]?.contentRect.width ?? el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fitAllPxPerDay = computeFitAllPxPerDay(rangeDays, containerWidthPx || 1);
  // Mirrors fitAllPxPerDay on every render for zoomByFactor to read — that
  // function is exposed through useImperativeHandle with a stable (empty)
  // dependency array (see below), so it must never close over a value that
  // can go stale; a ref updated unconditionally every render never does.
  const fitAllPxPerDayRef = useRef(fitAllPxPerDay);
  fitAllPxPerDayRef.current = fitAllPxPerDay;

  // null = "auto-fit" (track fitAllPxPerDay as the range/container change,
  // e.g. a filter narrows the employee set) — the moment the user zooms
  // in/out it becomes a concrete density and stops auto-following, until
  // Full timeline/fitAll() explicitly returns it to auto.
  const [manualPxPerDay, setManualPxPerDay] = useState<number | null>(null);
  const pxPerDay = manualPxPerDay ?? fitAllPxPerDay;

  const canZoomOut = pxPerDay > fitAllPxPerDay + ZOOM_EPSILON;
  const canZoomIn = pxPerDay < MAX_PX_PER_DAY - ZOOM_EPSILON;
  useEffect(() => {
    onZoomLimitsChange?.(canZoomIn, canZoomOut);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canZoomIn, canZoomOut, onZoomLimitsChange]);

  // Keeps the date under a fixed viewport offset stationary across a zoom
  // change — set right before changing pxPerDay, consumed by the layout
  // effect below once the new (wider/narrower) track has actually rendered.
  const pendingAnchorRef = useRef<{ dayOffsetFromStart: number; viewportOffsetPx: number } | null>(null);

  // Takes a MULTIPLIER (not an absolute target density) and applies it via
  // React's functional setState form — computing the new value from
  // whatever the CURRENT state actually is when the update is applied,
  // rather than from a `pxPerDay` closed over at call time. That matters
  // because React batches state updates: several zoomIn()/zoomOut() calls
  // fired in the same tick (e.g. a fast double-click, or a burst of wheel
  // notches) would otherwise all compute their clamped result from the
  // SAME stale pre-batch density and collapse to a single step instead of
  // compounding.
  function zoomByFactor(factor: number, viewportOffsetPx: number) {
    const wrap = wrapRef.current;
    if (!wrap) return;
    setManualPxPerDay((prevManual) => {
      const floor = fitAllPxPerDayRef.current;
      const current = prevManual ?? floor;
      const clamped = Math.min(MAX_PX_PER_DAY, Math.max(floor, current * factor));
      if (Math.abs(clamped - current) < ZOOM_EPSILON) return prevManual;
      const absoluteX = wrap.scrollLeft + viewportOffsetPx;
      pendingAnchorRef.current = { dayOffsetFromStart: absoluteX / current, viewportOffsetPx };
      return clamped;
    });
  }

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const anchor = pendingAnchorRef.current;
    if (!wrap || !anchor) return;
    pendingAnchorRef.current = null;
    wrap.scrollLeft = Math.max(0, anchor.dayOffsetFromStart * pxPerDay - anchor.viewportOffsetPx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pxPerDay]);

  useImperativeHandle(
    ref,
    () => ({
      zoomIn: () => zoomByFactor(ZOOM_STEP_FACTOR, (wrapRef.current?.clientWidth ?? 0) / 2),
      zoomOut: () => zoomByFactor(1 / ZOOM_STEP_FACTOR, (wrapRef.current?.clientWidth ?? 0) / 2),
      fitAll: () => setManualPxPerDay(null),
    }),
    []
  );

  // Ctrl/Cmd+wheel (also how trackpad pinch-to-zoom is reported by
  // Chrome/Firefox) zooms anchored on the pointer position — "Zoom around
  // the pointer position when possible." A plain wheel (no modifier,
  // including a two-finger trackpad swipe's deltaX) is left completely
  // alone: overflow-x: auto already scrolls it natively, no JS needed.
  function handleWheel(e: ReactWheelEvent<HTMLDivElement>) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const wrap = wrapRef.current;
    if (!wrap) return;
    const viewportOffsetPx = e.clientX - wrap.getBoundingClientRect().left;
    const factor = e.deltaY < 0 ? ZOOM_STEP_FACTOR : 1 / ZOOM_STEP_FACTOR;
    zoomByFactor(factor, viewportOffsetPx);
  }

  // -- middle-mouse panning -------------------------------------------
  // Direct-manipulation panning: dragging left moves the CONTENT left (as
  // if grabbing the timeline itself), revealing later dates; dragging
  // right reveals earlier dates. Pointer Events (not plain mouse events)
  // so setPointerCapture keeps the drag smooth even if the cursor briefly
  // leaves the wrap mid-drag.
  const panStateRef = useRef<{ startClientX: number; startScrollLeft: number; pointerId: number } | null>(null);
  // Sticks at true for one click cycle after a real drag — a capture-phase
  // click handler below reads it to swallow the click a drag shouldn't
  // have produced, then clears it, rather than a bar's own onClick needing
  // to know anything about panning.
  const didDragRef = useRef(false);
  const DRAG_THRESHOLD_PX = 4;

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 1) return; // middle button only — left-click/tap behavior (bar clicks, native touch scroll) is untouched
    e.preventDefault(); // suppresses the browser's own middle-click autoscroll mode, scoped to this element only
    const wrap = wrapRef.current;
    if (!wrap) return;
    wrap.setPointerCapture(e.pointerId);
    panStateRef.current = { startClientX: e.clientX, startScrollLeft: wrap.scrollLeft, pointerId: e.pointerId };
    wrap.style.cursor = "grabbing";
    wrap.style.userSelect = "none";
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const pan = panStateRef.current;
    const wrap = wrapRef.current;
    if (!pan || !wrap || pan.pointerId !== e.pointerId) return;
    const dx = e.clientX - pan.startClientX;
    if (Math.abs(dx) > DRAG_THRESHOLD_PX) didDragRef.current = true;
    wrap.scrollLeft = pan.startScrollLeft - dx;
  }

  function endPan(e: ReactPointerEvent<HTMLDivElement>) {
    const pan = panStateRef.current;
    const wrap = wrapRef.current;
    if (!pan || pan.pointerId !== e.pointerId) return;
    wrap?.releasePointerCapture(e.pointerId);
    panStateRef.current = null;
    if (wrap) {
      wrap.style.cursor = "";
      wrap.style.userSelect = "";
    }
  }

  // Capture phase: runs before the click would otherwise reach a bar's own
  // onClick, so a drag that happened to end over a bar never opens its
  // editor. Middle-button drags don't produce a `click` at all in normal
  // browser behavior (click is primary-button-only) — this is a deliberate
  // extra safety net for the requirement, not a workaround for an observed
  // false click.
  function handleClickCapture(e: ReactMouseEvent<HTMLDivElement>) {
    if (didDragRef.current) {
      didDragRef.current = false;
      e.stopPropagation();
      e.preventDefault();
    }
  }

  // Horizontal scroll offset of the date track, for the pinned year label.
  const [scrollLeftPx, setScrollLeftPx] = useState(0);

  const todayAnchorRef = useRef<HTMLDivElement>(null);
  const prevTokenRef = useRef(scrollToTodayToken);
  useEffect(() => {
    if (scrollToTodayToken !== prevTokenRef.current) {
      prevTokenRef.current = scrollToTodayToken;
      todayAnchorRef.current?.scrollIntoView?.({ inline: "center", block: "nearest" });
    }
  }, [scrollToTodayToken]);

  const scale = buildTimelineScale(range, pxPerDay);
  const pinnedYear = pinnedYearLabel(range, pxPerDay, scrollLeftPx);
  const todayInRange = today >= range.start && today <= range.end;
  const todayLeftPercent = percentInRange(today, range);
  const trackWidthPx = Math.max(rangeDays * pxPerDay, 1);
  const hasMinorRow = scale.minor !== null;

  return (
    <div className={`employment-timeline-graph-outer${hasMinorRow ? " employment-timeline-has-minor-row" : ""}`}>
      <div className="employment-timeline-body">
        {/* Numbers and names: a separate panel that is never inside the
            horizontally scrolling element, so it can't drift at long scroll
            distances (a sticky column inside the scroller once did). Its
            header and rows use the same fixed heights as the date track's,
            so row n here always lines up with bar n. */}
        <div className="employment-timeline-rowheads">
          <div className="employment-timeline-rowheads-header">
            <span className="employment-timeline-rowhead-number">#</span>
            <span>Employee</span>
          </div>
          {employees.map((emp, i) => {
            const name = `${emp.firstName} ${emp.lastName}`;
            return (
              <div key={emp.id} className="employment-timeline-rowhead" data-employee-id={emp.id}>
                <span className="employment-timeline-rowhead-number">{i + 1}</span>
                <span className="employment-timeline-rowhead-name" title={name}>
                  {name}
                </span>
              </div>
            );
          })}
        </div>

        <div
          ref={wrapRef}
          className="employment-timeline-graph-wrap"
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          onClickCapture={handleClickCapture}
          onScroll={(e) => setScrollLeftPx(e.currentTarget.scrollLeft)}
        >
          <div className="employment-timeline-graph" style={{ width: `${trackWidthPx}px` }}>
            <div className="employment-timeline-scale">
              <div className="employment-timeline-scale-row employment-timeline-scale-years">
                {scale.years.map((seg) => (
                  <div
                    key={seg.key}
                    className={`employment-timeline-scale-cell${seg.isBoundary ? " employment-timeline-scale-boundary" : ""}`}
                    style={{ left: `${seg.leftPercent}%`, width: `${seg.widthPercent}%` }}
                    data-date={seg.key}
                  >
                    {seg.showLabel && seg.label}
                  </div>
                ))}
                {pinnedYear && (
                  // Keeps the year visible while scrolled into the middle of it.
                  <div className="employment-timeline-scale-pinned-year" style={{ left: `${scrollLeftPx}px` }}>
                    {pinnedYear}
                  </div>
                )}
              </div>
              <div className="employment-timeline-scale-row employment-timeline-scale-months">
                {scale.months.map((seg) => (
                  <div
                    key={seg.key}
                    className={`employment-timeline-scale-cell${seg.isBoundary ? " employment-timeline-scale-boundary" : ""}`}
                    style={{ left: `${seg.leftPercent}%`, width: `${seg.widthPercent}%` }}
                    data-date={seg.key}
                  >
                    {seg.showLabel && seg.label}
                  </div>
                ))}
              </div>
              {scale.minor && (
                <div className="employment-timeline-scale-row employment-timeline-scale-minor">
                  {scale.minor.marks.map((m) => (
                    <div key={m.key} className="employment-timeline-scale-tick" style={{ left: `${m.leftPercent}%` }} data-date={m.key}>
                      {m.label}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* One gridline per month start (stronger on January 1) through
                every row, in the same coordinates as the bars. */}
            <div className="employment-timeline-grid" aria-hidden="true">
              {scale.months
                .filter((seg) => seg.isBoundary)
                .map((seg) => (
                  <div
                    key={seg.key}
                    className={`employment-timeline-gridline${seg.key.endsWith("-01-01") ? " employment-timeline-gridline-year" : ""}`}
                    style={{ left: `${seg.leftPercent}%` }}
                    data-date={seg.key}
                  />
                ))}
              {todayInRange && (
                <div
                  ref={todayAnchorRef}
                  className="employment-timeline-today-marker"
                  style={{ left: `${todayLeftPercent}%` }}
                  title={`Today, ${today}`}
                />
              )}
            </div>

            {employees.map((emp, i) => {
              const number = i + 1;
              const name = `${emp.firstName} ${emp.lastName}`;
              const pos = computeBarPosition(emp, range);
              const vacation = pos?.inRange ? computeVacationPosition(emp, range) : null;
              return (
                <div key={emp.id} className="employment-timeline-track" data-employee-id={emp.id}>
                  {!pos ? (
                    // Nothing to draw from (no Employment Start Date) — a
                    // full-width dashed row that opens the editor to fix it.
                    <button
                      type="button"
                      className="employment-timeline-bar employment-timeline-bar-missing-dates"
                      style={{ left: "0%", width: "100%" }}
                      disabled={!canEdit}
                      onClick={canEdit ? () => onEditDates(emp) : undefined}
                      aria-label={`${number}. ${name}: add an Employment Start Date`}
                      title={`${number}. ${name} — no Employment Start Date recorded`}
                    >
                      <span className="employment-timeline-bar-label">Missing Employment Start Date</span>
                    </button>
                  ) : (
                    <>
                      {emp.workPermit && emp.workPermit.expiryDate >= range.start && emp.workPermit.expiryDate <= range.end && (
                        <div
                          className="employment-timeline-permit-marker"
                          style={{ left: `${percentInRange(emp.workPermit.expiryDate, range)}%` }}
                          title={`Work permit expires ${emp.workPermit.expiryDate}`}
                          aria-label={`Work permit expires ${emp.workPermit.expiryDate}`}
                        />
                      )}
                      {pos.inRange && (
                        <button
                          type="button"
                          className={`employment-timeline-bar ${barStateClass(emp.timelineLabel ?? "ongoing")}`}
                          style={{ left: `${pos.leftPercent}%`, width: `${pos.widthPercent}%` }}
                          onClick={() => onEditDates(emp)}
                          aria-label={`${number}. ${name}: ${canEdit ? "edit" : "view"} employment dates`}
                          title={barTooltip(number, emp, pos.clippedStart)}
                          data-start={emp.employmentStartDate ?? undefined}
                          data-end={emp.timelineEndDate ?? "ongoing"}
                        >
                          {vacation && (
                            // Translucent orange over the blue bar (still employed), in the
                            // bar's own day slots; month lines continue through it.
                            <span
                              className="employment-timeline-vacation"
                              style={{
                                left: `${((vacation.leftPercent - pos.leftPercent) / pos.widthPercent) * 100}%`,
                                width: `${(vacation.widthPercent / pos.widthPercent) * 100}%`,
                              }}
                              title={`${vacationText(emp)} (still employed)`}
                              data-vacation-start={emp.vacationStartDate ?? undefined}
                              data-vacation-end={emp.vacationEndDate ?? undefined}
                            >
                              {vacation.monthLines.map((line) => (
                                <span
                                  key={line.key}
                                  className="employment-timeline-vacation-gridline"
                                  style={{ left: `${line.leftPercentOfSegment}%` }}
                                  aria-hidden="true"
                                />
                              ))}
                            </span>
                          )}
                          {pos.clippedStart && (
                            <span className="employment-timeline-bar-clip-notch" aria-hidden="true">
                              ◀
                            </span>
                          )}
                          <span className="employment-timeline-bar-label">{emp.timelineLabel ? TIMELINE_BAR_LABEL_TEXT[emp.timelineLabel] : ""}</span>
                        </button>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="employment-timeline-legend">
        {LEGEND.map((item) => (
          <span key={item.className} className="employment-timeline-legend-item">
            <span className={`employment-timeline-legend-swatch ${item.className}`} aria-hidden="true" />
            {item.label}
          </span>
        ))}
        <span className="employment-timeline-legend-item">
          <span className="employment-timeline-permit-marker employment-timeline-legend-marker" aria-hidden="true" />
          Work permit expiry
        </span>
        <span className="employment-timeline-legend-item">
          <span className="employment-timeline-today-marker employment-timeline-legend-marker" aria-hidden="true" />
          Today
        </span>
        <span className="employment-timeline-legend-item">
          <span className="employment-timeline-bar-clip-notch employment-timeline-legend-marker" aria-hidden="true">
            ◀
          </span>
          Continues before the displayed range
        </span>
      </div>
    </div>
  );
});
