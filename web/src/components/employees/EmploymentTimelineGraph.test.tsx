// @vitest-environment jsdom
//
// Focused component tests for the Graph's navigation/interaction layer:
// middle-mouse panning, drag-vs-click protection, zoom limits/Full
// timeline, and the clipped-start continuation indicator. Rendered
// directly (not through EmploymentTimelineTab) so the ref-based zoom API
// and pointer events can be driven precisely. jsdom never lays anything
// out, so HTMLElement.prototype.clientWidth is mocked to a realistic value
// per test (see EmploymentTimelineTab.test.tsx's own comment on the same
// limitation).
import "@testing-library/jest-dom/vitest";
import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmploymentTimelineGraph, EmploymentTimelineGraphHandle } from "./EmploymentTimelineGraph";
import { EmploymentTimelineEmployee, EmploymentPeriod } from "../../lib/employmentPeriodTypes";
import { TimelineRange } from "../../lib/employmentTimeline";

function period(overrides: Partial<EmploymentPeriod> = {}): EmploymentPeriod {
  return {
    id: "p1",
    employeeId: "e1",
    startDate: "2026-01-01",
    expectedFinishDate: null,
    actualFinishDate: null,
    employmentType: null,
    workGroup: null,
    workGroupOtherDescription: null,
    notes: null,
    statuses: ["current"],
    timelineEffectiveEndDate: "2026-06-15",
    timelineLabel: "ongoing",
    synthesized: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function employee(overrides: Partial<EmploymentTimelineEmployee> = {}): EmploymentTimelineEmployee {
  return {
    id: "e1",
    firstName: "Alice",
    lastName: "Smith",
    nationality: null,
    jobGroup: null,
    isActive: true,
    workPermit: null,
    hasUsableDates: true,
    periods: [period()],
    ...overrides,
  };
}

const RANGE: TimelineRange = { start: "2026-01-01", end: "2026-06-15" };

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 1400 });
});

afterEach(() => {
  cleanup();
});

describe("EmploymentTimelineGraph — zoom", () => {
  it("Full timeline (fitAll) fits the entire range inside the container width, with zoom-out disabled at that point", async () => {
    const ref = createRef<EmploymentTimelineGraphHandle>();
    const onZoomLimitsChange = vi.fn();
    render(
      <EmploymentTimelineGraph
        ref={ref}
        employees={[employee()]}
        range={RANGE}
        today="2026-03-01"
        canEdit
        scrollToTodayToken={0}
        onZoomLimitsChange={onZoomLimitsChange}
        onBarClick={vi.fn()}
        onAddPeriod={vi.fn()}
      />
    );

    const track = document.querySelector(".employment-timeline-track") as HTMLElement;
    // 1400px container / 165 days ≈ 8.48px/day — fitAll should land there.
    const rangeDays = 165;
    expect(parseFloat(track.style.minWidth)).toBeCloseTo(1400, 0);

    // Zoom out is already at its true limit at mount (fitAll is the
    // default), so onZoomLimitsChange must report canZoomOut: false.
    const lastCall = onZoomLimitsChange.mock.calls[onZoomLimitsChange.mock.calls.length - 1];
    expect(lastCall[1]).toBe(false); // canZoomOut
    expect(lastCall[0]).toBe(true); // canZoomIn — plenty of room to zoom in further
    void rangeDays;
  });

  it("zoomIn increases pixel density; zoomOut returns to the fit-all floor and disables further zoom-out", async () => {
    const ref = createRef<EmploymentTimelineGraphHandle>();
    render(
      <EmploymentTimelineGraph
        ref={ref}
        employees={[employee()]}
        range={RANGE}
        today="2026-03-01"
        canEdit
        scrollToTodayToken={0}
        onBarClick={vi.fn()}
        onAddPeriod={vi.fn()}
      />
    );
    const track = () => document.querySelector(".employment-timeline-track") as HTMLElement;
    const baseline = parseFloat(track().style.minWidth);

    act(() => ref.current!.zoomIn());
    expect(parseFloat(track().style.minWidth)).toBeGreaterThan(baseline);

    act(() => ref.current!.zoomOut());
    expect(parseFloat(track().style.minWidth)).toBeCloseTo(baseline, 0);
  });

  it("rapid zoomIn calls in the same tick still compound (not all collapsing to a single step)", () => {
    const ref = createRef<EmploymentTimelineGraphHandle>();
    render(
      <EmploymentTimelineGraph ref={ref} employees={[employee()]} range={RANGE} today="2026-03-01" canEdit scrollToTodayToken={0} onBarClick={vi.fn()} onAddPeriod={vi.fn()} />
    );
    const track = () => document.querySelector(".employment-timeline-track") as HTMLElement;
    const baseline = parseFloat(track().style.minWidth);
    act(() => {
      ref.current!.zoomIn();
      ref.current!.zoomIn();
    });
    // Two compounding 1.6x steps (~2.56x), not one (~1.6x) — confirms each
    // call reads the latest pending density, not a stale pre-batch value.
    expect(parseFloat(track().style.minWidth)).toBeGreaterThan(baseline * 2);
  });

  it("zoomIn cannot exceed MAX_PX_PER_DAY (close-in day/week inspection ceiling)", () => {
    const ref = createRef<EmploymentTimelineGraphHandle>();
    const shortRange: TimelineRange = { start: "2026-01-01", end: "2026-01-10" };
    render(
      <EmploymentTimelineGraph
        ref={ref}
        employees={[employee({ periods: [period({ startDate: "2026-01-01", timelineEffectiveEndDate: "2026-01-05" })] })]}
        range={shortRange}
        today="2026-01-10"
        canEdit
        scrollToTodayToken={0}
        onBarClick={vi.fn()}
        onAddPeriod={vi.fn()}
      />
    );
    const track = () => document.querySelector(".employment-timeline-track") as HTMLElement;
    // Zoom in repeatedly — density must clamp at MAX_PX_PER_DAY (60) * 9 days = 540px, never grow unbounded.
    act(() => {
      for (let i = 0; i < 20; i++) ref.current!.zoomIn();
    });
    expect(parseFloat(track().style.minWidth)).toBeLessThanOrEqual(60 * 9 + 1);
  });
});

describe("EmploymentTimelineGraph — clipped-start continuation indicator", () => {
  it("a period starting before the displayed range renders the clip notch, drawn from the boundary, with the true start date in the tooltip", () => {
    const emp = employee({ periods: [period({ startDate: "2024-01-01", timelineLabel: "ongoing", timelineEffectiveEndDate: "2026-03-01" })] });
    render(
      <EmploymentTimelineGraph
        employees={[emp]}
        range={{ start: "2026-01-01", end: "2026-06-15" }}
        today="2026-03-01"
        canEdit
        scrollToTodayToken={0}
        onBarClick={vi.fn()}
        onAddPeriod={vi.fn()}
      />
    );
    const bar = screen.getByRole("button", { name: "View or edit Alice Smith's employment period" });
    expect(bar.style.left).toBe("0%");
    expect(bar.querySelector(".employment-timeline-bar-clip-notch")).toBeInTheDocument();
    expect(bar.getAttribute("title")).toContain("2024-01-01");
    expect(bar.getAttribute("title")).toContain("employment began before the displayed range");
  });

  it("a period starting inside the displayed range shows no clip notch", () => {
    const emp = employee({ periods: [period({ startDate: "2026-02-01", timelineLabel: "ongoing", timelineEffectiveEndDate: "2026-03-01" })] });
    render(
      <EmploymentTimelineGraph
        employees={[emp]}
        range={{ start: "2026-01-01", end: "2026-06-15" }}
        today="2026-03-01"
        canEdit
        scrollToTodayToken={0}
        onBarClick={vi.fn()}
        onAddPeriod={vi.fn()}
      />
    );
    const bar = screen.getByRole("button", { name: "View or edit Alice Smith's employment period" });
    expect(bar.querySelector(".employment-timeline-bar-clip-notch")).not.toBeInTheDocument();
  });
});

describe("EmploymentTimelineGraph — middle-mouse panning", () => {
  function pointerEvent(type: string, init: { clientX: number; button?: number; pointerId?: number }): Event {
    const eventInit = { bubbles: true, cancelable: true, clientX: init.clientX, button: init.button ?? 0, pointerId: init.pointerId ?? 1 };
    if (typeof PointerEvent !== "undefined") return new PointerEvent(type, eventInit);
    return new MouseEvent(type, eventInit); // fallback for a jsdom build with no PointerEvent global
  }

  it("dragging left with the middle button increases scrollLeft (reveals later dates); a real click still works normally", () => {
    const onBarClick = vi.fn();
    render(
      <EmploymentTimelineGraph
        employees={[employee()]}
        range={RANGE}
        today="2026-03-01"
        canEdit
        scrollToTodayToken={0}
        onBarClick={onBarClick}
        onAddPeriod={vi.fn()}
      />
    );
    const wrap = document.querySelector(".employment-timeline-graph-wrap") as HTMLElement;
    // jsdom doesn't implement real scrolling metrics or setPointerCapture —
    // stub just enough for the handlers to run without throwing.
    Object.defineProperty(wrap, "scrollLeft", { configurable: true, writable: true, value: 100 });
    wrap.setPointerCapture = vi.fn();
    wrap.releasePointerCapture = vi.fn();

    fireEvent(wrap, pointerEvent("pointerdown", { clientX: 500, button: 1 }));
    expect(wrap.style.cursor).toBe("grabbing");

    fireEvent(wrap, pointerEvent("pointermove", { clientX: 480, button: 1 })); // moved left by 20px
    // dragStartScrollLeft (100) - dx (480-500=-20) = 120 — scrollLeft increased, later dates revealed.
    expect(wrap.scrollLeft).toBe(120);

    fireEvent(wrap, pointerEvent("pointerup", { clientX: 480, button: 1 }));
    expect(wrap.style.cursor).toBe("");

    // The drag exceeded the click-suppression threshold — a click landing
    // on a bar right after must not open its editor.
    const bar = screen.getByRole("button", { name: "View or edit Alice Smith's employment period" });
    fireEvent.click(bar);
    expect(onBarClick).not.toHaveBeenCalled();

    // A genuine subsequent click (no drag beforehand) works normally.
    fireEvent.click(bar);
    expect(onBarClick).toHaveBeenCalledTimes(1);
  });

  it("dragging right decreases scrollLeft (reveals earlier dates)", () => {
    render(
      <EmploymentTimelineGraph employees={[employee()]} range={RANGE} today="2026-03-01" canEdit scrollToTodayToken={0} onBarClick={vi.fn()} onAddPeriod={vi.fn()} />
    );
    const wrap = document.querySelector(".employment-timeline-graph-wrap") as HTMLElement;
    Object.defineProperty(wrap, "scrollLeft", { configurable: true, writable: true, value: 200 });
    wrap.setPointerCapture = vi.fn();
    wrap.releasePointerCapture = vi.fn();

    fireEvent(wrap, pointerEvent("pointerdown", { clientX: 300, button: 1 }));
    fireEvent(wrap, pointerEvent("pointermove", { clientX: 350, button: 1 })); // moved right by 50px
    expect(wrap.scrollLeft).toBe(150); // 200 - (350-300)
    fireEvent(wrap, pointerEvent("pointerup", { clientX: 350, button: 1 }));
  });

  it("a plain left-button click (no drag) is untouched — no cursor change, no click suppression", () => {
    const onBarClick = vi.fn();
    render(
      <EmploymentTimelineGraph employees={[employee()]} range={RANGE} today="2026-03-01" canEdit scrollToTodayToken={0} onBarClick={onBarClick} onAddPeriod={vi.fn()} />
    );
    const wrap = document.querySelector(".employment-timeline-graph-wrap") as HTMLElement;
    fireEvent(wrap, pointerEvent("pointerdown", { clientX: 500, button: 0 }));
    expect(wrap.style.cursor).toBe("");
    const bar = screen.getByRole("button", { name: "View or edit Alice Smith's employment period" });
    fireEvent.click(bar);
    expect(onBarClick).toHaveBeenCalledTimes(1);
  });
});
