// @vitest-environment jsdom
//
// Focused component tests for the Graph: the numbered employee column
// (lined up row-for-row with the bars, renumbered for whatever list it's
// given), the year/month date scale and month gridlines, bar clicks opening
// the dates editor, the clipped-start indicator, zoom limits/Full timeline
// and middle-mouse panning. Rendered directly so the ref-based zoom API and
// pointer events can be driven precisely. jsdom never lays anything out, so
// HTMLElement.prototype.clientWidth is mocked to a realistic value.
import "@testing-library/jest-dom/vitest";
import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmploymentTimelineGraph, EmploymentTimelineGraphHandle } from "./EmploymentTimelineGraph";
import { EmploymentTimelineEmployee } from "../../lib/employmentPeriodTypes";
import { TimelineRange } from "../../lib/employmentTimeline";

function employee(overrides: Partial<EmploymentTimelineEmployee> = {}): EmploymentTimelineEmployee {
  return {
    id: "e1",
    firstName: "Alice",
    lastName: "Smith",
    nationality: null,
    jobGroup: null,
    employeeGroup: null,
    isActive: true,
    employmentStartDate: "2026-01-01",
    workPermitExpiryDate: null,
    endDifferentDate: null,
    vacationStartDate: null,
    vacationEndDate: null,
    workPermit: null,
    employmentType: null,
    workGroup: null,
    hasUsableDates: true,
    timelineEndDate: null,
    timelineEndSource: null,
    timelineLabel: "ongoing",
    statuses: ["current"],
    ...overrides,
  };
}

const RANGE: TimelineRange = { start: "2026-01-01", end: "2026-06-15" };
const graphWidth = () => parseFloat((document.querySelector(".employment-timeline-graph") as HTMLElement).style.width);

function renderGraph(props: Partial<Parameters<typeof EmploymentTimelineGraph>[0]> & { ref?: React.Ref<EmploymentTimelineGraphHandle> } = {}) {
  return render(
    <EmploymentTimelineGraph
      employees={[employee()]}
      range={RANGE}
      today="2026-03-01"
      canEdit
      scrollToTodayToken={0}
      onEditDates={vi.fn()}
      {...props}
    />
  );
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 1400 });
});

afterEach(() => {
  cleanup();
});

describe("EmploymentTimelineGraph — numbered employee column", () => {
  const people = [
    employee({ id: "a", firstName: "Alice", lastName: "Arnold" }),
    employee({ id: "b", firstName: "Maximiliano-Bartholomew", lastName: "Featherstonehaugh-Worthington", hasUsableDates: false, employmentStartDate: null, timelineLabel: null }),
    employee({ id: "c", firstName: "Carla", lastName: "Cruz", employmentStartDate: "2026-02-01" }),
  ];

  it("numbers rows 1..n beside the names, in the same order as the bar rows", () => {
    renderGraph({ employees: people });
    const heads = [...document.querySelectorAll(".employment-timeline-rowhead")];
    const tracks = [...document.querySelectorAll(".employment-timeline-track")];
    expect(heads.map((h) => h.querySelector(".employment-timeline-rowhead-number")!.textContent)).toEqual(["1", "2", "3"]);
    expect(heads.map((h) => (h as HTMLElement).dataset.employeeId)).toEqual(tracks.map((t) => (t as HTMLElement).dataset.employeeId));
    expect(heads[1].querySelector(".employment-timeline-rowhead-name")).toHaveAttribute("title", "Maximiliano-Bartholomew Featherstonehaugh-Worthington");
    expect(screen.getByRole("button", { name: "3. Carla Cruz: edit employment dates" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2. Maximiliano-Bartholomew Featherstonehaugh-Worthington: add an Employment Start Date" })).toBeInTheDocument();
  });

  it("the numbers column sits outside the horizontally scrolling area (can't drift while scrolling)", () => {
    renderGraph({ employees: people });
    const wrap = document.querySelector(".employment-timeline-graph-wrap")!;
    expect(wrap.contains(document.querySelector(".employment-timeline-rowheads"))).toBe(false);
  });

  it("renumbers from 1 when given a filtered list", () => {
    renderGraph({ employees: [people[2]] });
    expect(document.querySelector(".employment-timeline-rowhead .employment-timeline-rowhead-number")!.textContent).toBe("1");
    expect(screen.getByRole("button", { name: "1. Carla Cruz: edit employment dates" })).toBeInTheDocument();
  });
});

describe("EmploymentTimelineGraph — date scale", () => {
  it("shows the year above Jan..Jun month labels, with a gridline on every month start", () => {
    renderGraph();
    const years = [...document.querySelectorAll(".employment-timeline-scale-years .employment-timeline-scale-cell")].map((c) => c.textContent);
    expect(years).toEqual(["2026"]);
    const months = [...document.querySelectorAll(".employment-timeline-scale-months .employment-timeline-scale-cell")].map((c) => c.textContent);
    expect(months).toEqual(["Jan", "Feb", "Mar", "Apr", "May", "Jun"]);
    const lines = [...document.querySelectorAll(".employment-timeline-gridline")].map((l) => (l as HTMLElement).dataset.date);
    expect(lines).toEqual(["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01"]);
  });

  it("gridlines and month labels share exactly the same positions as bar edges", () => {
    renderGraph({ employees: [employee({ employmentStartDate: "2026-03-01", timelineEndDate: "2026-04-30", timelineLabel: "employed" })] });
    const bar = screen.getByRole("button", { name: "1. Alice Smith: edit employment dates" }) as HTMLElement;
    const line = (date: string) => (document.querySelector(`.employment-timeline-gridline[data-date="${date}"]`) as HTMLElement).style.left;
    const cell = (date: string) => (document.querySelector(`.employment-timeline-scale-months [data-date="${date}"]`) as HTMLElement).style.left;
    expect(bar.style.left).toBe(line("2026-03-01"));
    expect(cell("2026-03-01")).toBe(line("2026-03-01"));
    expect(parseFloat(bar.style.left) + parseFloat(bar.style.width)).toBeCloseTo(parseFloat(line("2026-05-01")), 8);
  });

  it("draws a single Today marker inside the range", () => {
    renderGraph();
    expect(document.querySelectorAll(".employment-timeline-grid .employment-timeline-today-marker")).toHaveLength(1);
  });
});

describe("EmploymentTimelineGraph — bars", () => {
  it("clicking a bar opens the dates editor for that employee", () => {
    const onEditDates = vi.fn();
    renderGraph({ onEditDates });
    fireEvent.click(screen.getByRole("button", { name: "1. Alice Smith: edit employment dates" }));
    expect(onEditDates).toHaveBeenCalledWith(expect.objectContaining({ id: "e1" }));
  });

  it("a viewer who can't edit still opens a bar (read-only), but not the missing-dates row", () => {
    const onEditDates = vi.fn();
    renderGraph({ canEdit: false, onEditDates, employees: [employee(), employee({ id: "x", firstName: "No", lastName: "Start", hasUsableDates: false, employmentStartDate: null, timelineLabel: null })] });
    fireEvent.click(screen.getByRole("button", { name: "1. Alice Smith: view employment dates" }));
    expect(onEditDates).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "2. No Start: add an Employment Start Date" })).toBeDisabled();
  });

  it("a bar starting before the displayed range shows the clip notch, drawn from the boundary, with the true start in the tooltip", () => {
    renderGraph({ employees: [employee({ employmentStartDate: "2024-01-01" })] });
    const bar = screen.getByRole("button", { name: "1. Alice Smith: edit employment dates" });
    expect(bar.style.left).toBe("0%");
    expect(bar.querySelector(".employment-timeline-bar-clip-notch")).toBeInTheDocument();
    expect(bar.getAttribute("title")).toContain("Employment Start Date: 2024-01-01 (before the displayed range)");
  });

  it("a bar starting inside the range shows no clip notch, and its tooltip uses the new date names", () => {
    renderGraph({
      employees: [employee({ employmentStartDate: "2026-02-01", workPermitExpiryDate: "2026-09-30", endDifferentDate: "2026-05-15", timelineEndDate: "2026-05-15", timelineEndSource: "endDifferentDate", timelineLabel: "employed" })],
    });
    const bar = screen.getByRole("button", { name: "1. Alice Smith: edit employment dates" });
    expect(bar.querySelector(".employment-timeline-bar-clip-notch")).not.toBeInTheDocument();
    const title = bar.getAttribute("title")!;
    expect(title).toContain("Work Permit Expiry Date: 2026-09-30");
    expect(title).toContain("End Different Date: 2026-05-15");
    expect(title).toContain("Timeline ends: 2026-05-15 (End Different Date)");
  });
});

describe("EmploymentTimelineGraph — zoom", () => {
  it("Full timeline (fitAll) fits the entire range inside the date track's width, with zoom-out disabled at that point", () => {
    const onZoomLimitsChange = vi.fn();
    renderGraph({ onZoomLimitsChange });
    expect(graphWidth()).toBeCloseTo(1400, 0);
    const lastCall = onZoomLimitsChange.mock.calls[onZoomLimitsChange.mock.calls.length - 1];
    expect(lastCall).toEqual([true, false]); // can zoom in, can't zoom out
  });

  it("zoomIn increases pixel density; zoomOut returns to the fit-all floor", () => {
    const ref = createRef<EmploymentTimelineGraphHandle>();
    renderGraph({ ref });
    const baseline = graphWidth();
    act(() => ref.current!.zoomIn());
    expect(graphWidth()).toBeGreaterThan(baseline);
    act(() => ref.current!.zoomOut());
    expect(graphWidth()).toBeCloseTo(baseline, 0);
  });

  it("rapid zoomIn calls in the same tick still compound", () => {
    const ref = createRef<EmploymentTimelineGraphHandle>();
    renderGraph({ ref });
    const baseline = graphWidth();
    act(() => {
      ref.current!.zoomIn();
      ref.current!.zoomIn();
    });
    expect(graphWidth()).toBeGreaterThan(baseline * 2);
  });

  it("zoomIn cannot exceed MAX_PX_PER_DAY, and close zoom adds a day row", () => {
    const ref = createRef<EmploymentTimelineGraphHandle>();
    renderGraph({ ref, range: { start: "2026-01-01", end: "2026-01-10" }, today: "2026-01-10" });
    act(() => {
      for (let i = 0; i < 20; i++) ref.current!.zoomIn();
    });
    expect(graphWidth()).toBeLessThanOrEqual(60 * 10 + 1);
    expect(document.querySelectorAll(".employment-timeline-scale-minor .employment-timeline-scale-tick")).toHaveLength(10);
    expect(document.querySelector(".employment-timeline-graph-outer")).toHaveClass("employment-timeline-has-minor-row");
  });
});

describe("EmploymentTimelineGraph — middle-mouse panning", () => {
  function pointerEvent(type: string, init: { clientX: number; button?: number; pointerId?: number }): Event {
    const eventInit = { bubbles: true, cancelable: true, clientX: init.clientX, button: init.button ?? 0, pointerId: init.pointerId ?? 1 };
    if (typeof PointerEvent !== "undefined") return new PointerEvent(type, eventInit);
    return new MouseEvent(type, eventInit);
  }
  function stubWrap(scrollLeft: number) {
    const wrap = document.querySelector(".employment-timeline-graph-wrap") as HTMLElement;
    Object.defineProperty(wrap, "scrollLeft", { configurable: true, writable: true, value: scrollLeft });
    wrap.setPointerCapture = vi.fn();
    wrap.releasePointerCapture = vi.fn();
    return wrap;
  }

  it("dragging left with the middle button reveals later dates; the click a drag would produce is swallowed, a real click works", () => {
    const onEditDates = vi.fn();
    renderGraph({ onEditDates });
    const wrap = stubWrap(100);
    fireEvent(wrap, pointerEvent("pointerdown", { clientX: 500, button: 1 }));
    expect(wrap.style.cursor).toBe("grabbing");
    fireEvent(wrap, pointerEvent("pointermove", { clientX: 480, button: 1 }));
    expect(wrap.scrollLeft).toBe(120);
    fireEvent(wrap, pointerEvent("pointerup", { clientX: 480, button: 1 }));
    expect(wrap.style.cursor).toBe("");
    const bar = screen.getByRole("button", { name: "1. Alice Smith: edit employment dates" });
    fireEvent.click(bar);
    expect(onEditDates).not.toHaveBeenCalled();
    fireEvent.click(bar);
    expect(onEditDates).toHaveBeenCalledTimes(1);
  });

  it("dragging right reveals earlier dates", () => {
    renderGraph();
    const wrap = stubWrap(200);
    fireEvent(wrap, pointerEvent("pointerdown", { clientX: 300, button: 1 }));
    fireEvent(wrap, pointerEvent("pointermove", { clientX: 350, button: 1 }));
    expect(wrap.scrollLeft).toBe(150);
    fireEvent(wrap, pointerEvent("pointerup", { clientX: 350, button: 1 }));
  });

  it("a plain left-button click is untouched", () => {
    const onEditDates = vi.fn();
    renderGraph({ onEditDates });
    const wrap = document.querySelector(".employment-timeline-graph-wrap") as HTMLElement;
    fireEvent(wrap, pointerEvent("pointerdown", { clientX: 500, button: 0 }));
    expect(wrap.style.cursor).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "1. Alice Smith: edit employment dates" }));
    expect(onEditDates).toHaveBeenCalledTimes(1);
  });
});

describe("EmploymentTimelineGraph — vacation overlay", () => {
  const YEAR: TimelineRange = { start: "2026-01-01", end: "2026-12-31" };
  const withVacation = (overrides: Partial<EmploymentTimelineEmployee> = {}) =>
    employee({ timelineEndDate: "2026-12-31", timelineLabel: "employed", vacationStartDate: "2026-06-15", vacationEndDate: "2026-08-14", ...overrides });
  // The overlay's left/right edges in track percent (it's positioned inside the bar).
  const overlayEdges = () => {
    const bar = document.querySelector(".employment-timeline-bar:not(.employment-timeline-bar-missing-dates)") as HTMLElement;
    const seg = bar.querySelector(".employment-timeline-vacation") as HTMLElement;
    const barLeft = parseFloat(bar.style.left);
    const barWidth = parseFloat(bar.style.width);
    const left = barLeft + (parseFloat(seg.style.left) / 100) * barWidth;
    return { left, right: left + (parseFloat(seg.style.width) / 100) * barWidth, seg };
  };
  const gridline = (date: string) => parseFloat((document.querySelector(`.employment-timeline-gridline[data-date="${date}"]`) as HTMLElement).style.left);

  it("draws a translucent orange segment inside the blue bar from Start Vacation through End Vacation", () => {
    renderGraph({ range: YEAR, employees: [withVacation({ vacationStartDate: "2026-07-01", vacationEndDate: "2026-07-31" })] });
    const { left, right, seg } = overlayEdges();
    expect(left).toBeCloseTo(gridline("2026-07-01"), 8);
    expect(right).toBeCloseTo(gridline("2026-08-01"), 8); // through Jul 31 inclusive
    expect(seg).toHaveAttribute("title", "Vacation: 2026-07-01 – 2026-07-31 (still employed)");
    expect(seg.closest("button")).toHaveClass("employment-timeline-bar-current"); // the bar is still there (still employed)
  });

  it("keeps month gridlines through the orange, exactly on the timeline's gridlines", () => {
    renderGraph({ range: YEAR, employees: [withVacation()] });
    const { left, right, seg } = overlayEdges();
    const lines = [...seg.querySelectorAll(".employment-timeline-vacation-gridline")] as HTMLElement[];
    expect(lines).toHaveLength(2); // Jul 1 and Aug 1 inside Jun 15–Aug 14
    const toTrack = (l: HTMLElement) => left + (parseFloat(l.style.left) / 100) * (right - left);
    expect(toTrack(lines[0])).toBeCloseTo(gridline("2026-07-01"), 8);
    expect(toTrack(lines[1])).toBeCloseTo(gridline("2026-08-01"), 8);
  });

  it("adds the vacation to the bar tooltip; clicking the orange opens the editor; the label stays readable", () => {
    const onEditDates = vi.fn();
    renderGraph({ range: YEAR, onEditDates, employees: [withVacation()] });
    const bar = screen.getByRole("button", { name: "1. Alice Smith: edit employment dates" });
    expect(bar.getAttribute("title")).toContain("Vacation: 2026-06-15 – 2026-08-14");
    fireEvent.click(bar.querySelector(".employment-timeline-vacation")!);
    expect(onEditDates).toHaveBeenCalledTimes(1);
    expect(bar.querySelector(".employment-timeline-bar-label")!.textContent).toBe("Employed");
  });

  it("no vacation, or a vacation outside the visible range: no orange", () => {
    renderGraph({ range: YEAR, employees: [employee({ timelineEndDate: "2026-12-31", timelineLabel: "employed" })] });
    expect(document.querySelector(".employment-timeline-bar .employment-timeline-vacation")).toBeNull();
    cleanup();
    renderGraph({ range: { start: "2026-01-01", end: "2026-05-31" }, employees: [withVacation()] });
    expect(document.querySelector(".employment-timeline-bar .employment-timeline-vacation")).toBeNull();
  });

  it("in a filtered list the orange is on the right (renumbered) row", () => {
    renderGraph({
      range: YEAR,
      employees: [employee({ id: "z", firstName: "Zed", lastName: "Zulu", timelineEndDate: "2026-12-31", vacationStartDate: "2026-03-07", vacationEndDate: "2026-03-09" })],
    });
    const bar = screen.getByRole("button", { name: "1. Zed Zulu: edit employment dates" });
    expect(bar.querySelector(".employment-timeline-vacation")).toHaveAttribute("data-vacation-start", "2026-03-07");
  });

  it("lists Vacation in the legend", () => {
    renderGraph({ range: YEAR, employees: [withVacation()] });
    expect(screen.getByText("Vacation (still employed)")).toBeInTheDocument();
  });
});
