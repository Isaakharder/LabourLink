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
  computeBarPosition,
  buildTimelineHeaderMarks,
  computeFitAllPxPerDay,
  MAX_PX_PER_DAY,
  percentInRange,
  TimelineRange,
} from "../../lib/employmentTimeline";
import { EmploymentPeriod, EmploymentTimelineEmployee, TIMELINE_BAR_LABEL_TEXT } from "../../lib/employmentPeriodTypes";

interface EmploymentTimelineGraphProps {
  employees: EmploymentTimelineEmployee[];
  range: TimelineRange;
  today: string;
  canEdit: boolean;
  // Incremented by the Today button — this component scrolls the today
  // line into view in response, rather than the parent needing a DOM ref
  // into a component it doesn't otherwise touch.
  scrollToTodayToken: number;
  // Reported after every zoom-affecting change (range, container resize,
  // user zoom) so the toolbar's +/- buttons can disable themselves at the
  // true limits, without duplicating this component's own density math.
  onZoomLimitsChange?: (canZoomIn: boolean, canZoomOut: boolean) => void;
  onBarClick: (employee: EmploymentTimelineEmployee, period: EmploymentPeriod) => void;
  onAddPeriod: (employee: EmploymentTimelineEmployee) => void;
}

export interface EmploymentTimelineGraphHandle {
  zoomIn(): void;
  zoomOut(): void;
  // Resets to the exact "entire configured range fits inside the available
  // width, nothing to scroll" density — recomputed fresh against the
  // container's current measured width, not a cached/remembered value.
  fitAll(): void;
}

function barStateClass(label: EmploymentPeriod["timelineLabel"]): string {
  if (label === "completed") return "employment-timeline-bar-completed";
  if (label === "expiredStillWorking") return "employment-timeline-bar-expired-still-working";
  if (label === "ongoing") return "employment-timeline-bar-ongoing";
  return "employment-timeline-bar-current"; // "employed" — a normal in-progress bar with a real, future end
}

const LEGEND: { className: string; label: string }[] = [
  { className: "employment-timeline-bar-current", label: "Employed (scheduled finish/expiry)" },
  { className: "employment-timeline-bar-ongoing", label: "Ongoing (no end in sight)" },
  { className: "employment-timeline-bar-expired-still-working", label: "Expired — still working" },
  { className: "employment-timeline-bar-completed", label: "Completed" },
];

// Full detail for the hover/focus tooltip — name, status, start, end/expiry
// and work group, per the brief. The bar's visible label (name · status) is
// deliberately shorter; this is what a short, ellipsized bar still exposes
// on hover/focus. `clipped` adds the "began before the displayed range"
// note the brief requires for a bar clipped at the display boundary — the
// true startDate is still shown here even though the bar itself is drawn
// starting at the boundary, not the real date.
function periodTooltip(name: string, period: EmploymentPeriod, clipped: boolean): string {
  const label = TIMELINE_BAR_LABEL_TEXT[period.timelineLabel];
  const endText = period.timelineLabel === "ongoing" || period.timelineLabel === "expiredStillWorking" ? "present" : period.timelineEffectiveEndDate;
  return [
    `${name} — ${label}`,
    `Start: ${period.startDate}${clipped ? " (employment began before the displayed range)" : ""}`,
    `End/expiry: ${endText}`,
    `Work Group: ${period.workGroup ?? "Unspecified"}`,
    period.employmentType ? `Type: ${period.employmentType}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

// Zoom step multiplier per click/wheel-notch — chosen so a handful of
// clicks comfortably spans the full range from fit-all to MAX_PX_PER_DAY
// regardless of how many years the fitted range covers.
const ZOOM_STEP_FACTOR = 1.6;
// A wheel-zoom notch anchors on the pointer; below this we treat the two
// densities as equal (float drift guard), matching the same epsilon a
// button click's clamped comparison uses.
const ZOOM_EPSILON = 0.001;

export const EmploymentTimelineGraph = forwardRef<EmploymentTimelineGraphHandle, EmploymentTimelineGraphProps>(function EmploymentTimelineGraph(
  { employees, range, today, canEdit, scrollToTodayToken, onZoomLimitsChange, onBarClick, onAddPeriod },
  ref
) {
  const rangeDays = Math.max(1, Math.round((new Date(range.end).getTime() - new Date(range.start).getTime()) / 86400000));

  const wrapRef = useRef<HTMLDivElement>(null);
  const [containerWidthPx, setContainerWidthPx] = useState(0);
  useEffect(() => {
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

  const todayAnchorRef = useRef<HTMLDivElement>(null);
  // Compares against the PREVIOUS token rather than a mutable "is this the
  // first render" flag: a boolean flag flips permanently on the first
  // effect run and stays flipped through React 18 StrictMode's dev-only
  // double-invocation of effects, which would otherwise fire an unwanted
  // scroll-to-today on every mount. Comparing values instead is safe under
  // double-invocation — the second simulated run sees the same (unchanged)
  // token and correctly still skips.
  const prevTokenRef = useRef(scrollToTodayToken);
  useEffect(() => {
    if (scrollToTodayToken !== prevTokenRef.current) {
      prevTokenRef.current = scrollToTodayToken;
      todayAnchorRef.current?.scrollIntoView?.({ inline: "center", block: "nearest" });
    }
  }, [scrollToTodayToken]);

  const headerMarks = buildTimelineHeaderMarks(range, pxPerDay);
  const todayLeftPercent = percentInRange(today, range);
  const trackMinWidthPx = rangeDays * pxPerDay;

  return (
    <div className="employment-timeline-graph-outer">
      {/* No frozen employee-names column — each bar carries its own
          employee's name (see the label below), so the date track can use
          the full available width. Native overflow-x: auto is kept as the
          always-visible, always-accessible fallback for scrolling (trackpad
          two-finger swipe and touch swipe both already work through it with
          no extra code) — middle-mouse panning and Ctrl/Cmd+wheel zoom
          below are additions on top of it, not replacements. */}
      <div
        ref={wrapRef}
        className="employment-timeline-graph-wrap"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onClickCapture={handleClickCapture}
      >
        <div className="employment-timeline-graph">
          <div className="employment-timeline-header-track" style={{ minWidth: `${trackMinWidthPx}px` }}>
            {headerMarks.map((m) => (
              <div key={m.key} className="employment-timeline-month-mark" style={{ left: `${m.leftPercent}%` }}>
                {m.label}
              </div>
            ))}
            <div ref={todayAnchorRef} className="employment-timeline-today-anchor" style={{ left: `${todayLeftPercent}%` }} aria-hidden="true" />
          </div>

          {employees.map((emp) => {
            const name = `${emp.firstName} ${emp.lastName}`;
            return (
              <div key={emp.id} className="employment-timeline-track" style={{ minWidth: `${trackMinWidthPx}px`, position: "relative" }}>
                <div className="employment-timeline-today-marker" style={{ left: `${todayLeftPercent}%` }} />

                {!emp.hasUsableDates ? (
                  // Full-width dashed neutral row — nothing to draw a real
                  // bar from (no start date, no employment period), but
                  // still clickable (when the viewer can edit) to fix that,
                  // rather than the employee silently vanishing from the
                  // graph.
                  <button
                    type="button"
                    className="employment-timeline-bar employment-timeline-bar-missing-dates"
                    style={{ left: "0%", width: "100%" }}
                    disabled={!canEdit}
                    onClick={canEdit ? () => onAddPeriod(emp) : undefined}
                    aria-label={`Add employment dates for ${name}`}
                    title={`${name} — Missing employment dates. No start date or employment period is recorded for this employee.`}
                  >
                    <span className="employment-timeline-bar-label">{name} · Missing employment dates</span>
                  </button>
                ) : (
                  <>
                    {emp.workPermit &&
                      emp.workPermit.expiryDate >= range.start &&
                      emp.workPermit.expiryDate <= range.end &&
                      (() => {
                        const left = percentInRange(emp.workPermit!.expiryDate, range);
                        return (
                          <div
                            className="employment-timeline-permit-marker"
                            style={{ left: `${left}%` }}
                            title={`Work permit expires ${emp.workPermit!.expiryDate}`}
                            aria-label={`Work permit expires ${emp.workPermit!.expiryDate}`}
                          />
                        );
                      })()}
                    {emp.periods.map((period) => {
                      const pos = computeBarPosition(period, range);
                      const label = `${name} · ${TIMELINE_BAR_LABEL_TEXT[period.timelineLabel]}`;
                      // A synthesized bar has no real employment_periods row
                      // behind it (see employmentTimelineView.ts) — clicking
                      // it opens the Add-period flow instead of an editor
                      // for a period that doesn't actually exist yet, and
                      // (like adding one from scratch) only when the viewer
                      // can edit at all. A real period is always clickable,
                      // even read-only (Manager), to at least view it — the
                      // modal itself renders read-only in that case.
                      const clickable = period.synthesized ? canEdit : true;
                      const ariaLabel = period.synthesized ? `Add an employment period for ${name}` : `View or edit ${name}'s employment period`;
                      return (
                        <button
                          key={period.id}
                          type="button"
                          disabled={!clickable}
                          className={`employment-timeline-bar ${barStateClass(period.timelineLabel)}${period.synthesized ? " employment-timeline-bar-synthesized" : ""}`}
                          style={{ left: `${pos.leftPercent}%`, width: `${pos.widthPercent}%` }}
                          onClick={clickable ? () => (period.synthesized ? onAddPeriod(emp) : onBarClick(emp, period)) : undefined}
                          aria-label={ariaLabel}
                          title={period.synthesized ? ariaLabel : periodTooltip(name, period, pos.clippedStart)}
                        >
                          {pos.clippedStart && (
                            <span className="employment-timeline-bar-clip-notch" aria-hidden="true">
                              ◀
                            </span>
                          )}
                          <span className="employment-timeline-bar-label">{label}</span>
                        </button>
                      );
                    })}
                  </>
                )}
              </div>
            );
          })}
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
