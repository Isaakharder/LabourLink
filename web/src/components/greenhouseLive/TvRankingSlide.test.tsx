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
    expect(rows[0]).toHaveTextContent("1000 stems/hour");
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

  it("puts a very short bar's labels outside", () => {
    const s = slide(2);
    s.employees[1].speed = 15;
    renderSlide(s);
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]).toHaveClass("tv-chart-label-inside");
    expect(rows[1]).toHaveClass("tv-chart-label-outside");
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
