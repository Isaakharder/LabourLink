// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivitySlide } from "../../lib/greenhouseLiveTypes";
import { TvRankingSlide } from "./TvRankingSlide";

function slide(count: number, over: Partial<ActivitySlide> = {}): ActivitySlide {
  return {
    activityId: "pick",
    activityName: "Picking Peppers",
    speedUnit: "stems/hour",
    target: 500,
    minimumActivityHours: 0,
    topN: null,
    slideSeconds: 15,
    atTargetColor: "#15803d",
    belowTargetColor: "#dc2626",
    status: "ok",
    reason: null,
    notice: null,
    employees: Array.from({ length: count }, (_, i) => ({
      firstName: `Worker${i + 1}`,
      lastInitial: "Q.",
      speed: 1000 - i * 15,
      activityHours: 4,
      quantityCounted: 100,
    })),
    belowMinimumHours: 0,
    employeesWithoutSpeed: 0,
    computedAt: "2026-10-12T12:00:00Z",
    ...over,
  };
}

// jsdom has no layout: give the chart a 1920×1080-like size.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1872);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(950);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderSlide(s: ActivitySlide) {
  return render(<TvRankingSlide item={{ kind: "activity", key: s.activityId, seconds: s.slideSeconds, slide: s }} />);
}

describe("TV bar chart slide", () => {
  it("shows all 60 employees on one screen, fastest first", () => {
    renderSlide(slide(60));
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(60);
    expect(rows[0]).toHaveTextContent("Worker1 Q.");
    expect(rows[0].querySelector(".tv-chart-name")).toHaveTextContent("Worker1 Q.");
    expect(rows[0].querySelector(".tv-chart-speed")).toHaveTextContent("1000 stm/hr");
    expect(rows[59]).toHaveTextContent("Worker60 Q.");
    const tops = rows.map((r) => parseFloat(r.style.top));
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
    expect(tops[59] + parseFloat(rows[59].style.height)).toBeLessThanOrEqual(950);
  });

  it("colours bars by target: equal counts as meeting it", () => {
    renderSlide(slide(3, { target: 985 })); // speeds 1000, 985, 970
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-meets-target"))).toEqual(["true", "true", "false"]);
    const bars = rows.map((r) => (r.querySelector(".tv-chart-bar") as HTMLElement).getAttribute("data-color"));
    expect(bars).toEqual(["#15803d", "#15803d", "#dc2626"]);
  });

  it("a refresh with more employees and new colours re-lays out cleanly", () => {
    const { rerender } = renderSlide(slide(5));
    const before = screen.getAllByRole("listitem");
    const thickBefore = parseFloat(before[0].style.height);
    const s2 = slide(40, { atTargetColor: "#1d4ed8", belowTargetColor: "#f59e0b" });
    rerender(<TvRankingSlide item={{ kind: "activity", key: s2.activityId, seconds: 15, slide: s2 }} />);
    const after = screen.getAllByRole("listitem");
    expect(after).toHaveLength(40);
    expect(parseFloat(after[0].style.height)).toBeLessThan(thickBefore);
    expect((after[0].querySelector(".tv-chart-bar") as HTMLElement).getAttribute("data-color")).toBe("#1d4ed8");
    expect((after[39].querySelector(".tv-chart-bar") as HTMLElement).getAttribute("data-color")).toBe("#f59e0b");
  });

  it("both fit: name at the bar's left, speed right-aligned to the bar's end", () => {
    const s = slide(2);
    s.employees[0].displayName = "Jhang Jhang";
    s.employees[0].speed = 1389;
    renderSlide(s);
    const row = screen.getAllByRole("listitem")[0];
    expect(row).toHaveClass("tv-chart-label-split");
    const name = row.querySelector(".tv-chart-name") as HTMLElement;
    const speed = row.querySelector(".tv-chart-speed") as HTMLElement;
    expect(name).toHaveTextContent("Jhang Jhang");
    expect(speed).toHaveTextContent("1389 stm/hr");
    expect(row.querySelector(".tv-chart-sep")).toBeNull();
    // Full-width bar: speed's right edge one padding (16px at 32px text) in from the bar's end.
    expect(speed.style.right).toBe("16px");
    expect(speed.style.left).toBe("");
    expect(speed.style.color).toBe(name.style.color);
  });

  it("name fits but not both: speed immediately past the bar, in the normal text colour", () => {
    const s = slide(2, { target: null });
    s.employees[0].speed = 1000;
    s.employees[1].speed = 150; // ~281px bar at 1872px
    s.employees[1].displayName = "Ana";
    renderSlide(s);
    const row = screen.getAllByRole("listitem")[1];
    expect(row).toHaveClass("tv-chart-label-name-inside");
    const bar = row.querySelector(".tv-chart-bar") as HTMLElement;
    const speed = row.querySelector(".tv-chart-speed") as HTMLElement;
    expect(parseFloat(speed.style.left)).toBeCloseTo(parseFloat(bar.style.width) + 16);
    expect(speed.style.color).toBe("");
    expect(parseFloat(speed.style.left)).toBeLessThan(1872 / 2);
  });

  it("name doesn't fit: one 'Name · speed' label just past the short bar", () => {
    const s = slide(2);
    s.employees[1].speed = 15;
    s.employees[1].displayName = "Marcelino Besa";
    renderSlide(s);
    const row = screen.getAllByRole("listitem")[1];
    expect(row).toHaveClass("tv-chart-label-outside");
    const labels = row.querySelectorAll(".tv-chart-label");
    expect(labels).toHaveLength(1);
    expect(labels[0]).toHaveTextContent("Marcelino Besa · 15 stm/hr");
    expect([...labels[0].children].map((c) => c.className)).toEqual(["tv-chart-name", "tv-chart-sep", "tv-chart-speed"]);
    const bar = row.querySelector(".tv-chart-bar") as HTMLElement;
    expect(parseFloat((labels[0] as HTMLElement).style.left)).toBeCloseTo(parseFloat(bar.style.width) + 16);
  });

  it("text is 20% smaller (32px with few employees, was 40px)", () => {
    renderSlide(slide(2));
    expect(screen.getAllByRole("listitem")[0].style.fontSize).toBe("32px");
  });

  it("keeps other speed units exactly as stored", () => {
    renderSlide(slide(1, { speedUnit: "plants/hour" }));
    expect(screen.getByRole("listitem")).toHaveTextContent("1000 plants/hour");
    expect(screen.getByText("Plants per hour")).toBeInTheDocument();
  });

  it("shows the full display name when the server sends one", () => {
    const s = slide(1);
    s.employees[0].displayName = "Marcelino Besa";
    renderSlide(s);
    expect(screen.getByRole("listitem")).toHaveTextContent("Marcelino Besa");
  });

  it("Top N from the server is respected — nothing extra appears", () => {
    renderSlide(slide(10, { topN: 10 }));
    expect(screen.getAllByRole("listitem")).toHaveLength(10);
  });
});
