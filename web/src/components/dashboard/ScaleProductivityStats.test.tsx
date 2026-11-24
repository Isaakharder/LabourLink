// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RowStemCard } from "./RowStemCard";
import { RowStemDashboardCard } from "../../lib/dashboardTypes";
import { TvRankingSlide } from "../greenhouseLive/TvRankingSlide";
import { ActivitySlide } from "../../lib/greenhouseLiveTypes";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const card = (over: Partial<RowStemDashboardCard> = {}): RowStemDashboardCard => ({
  employeeId: "e1",
  employeeFirstName: "Ana",
  employeeLastName: "Lopez",
  photoUrl: null,
  activityId: "pick",
  activityName: "Picking Peppers",
  runStartedAt: "2026-11-24T12:00:00Z",
  cardType: "row_stem",
  densityType: "stems",
  rowLabel: null,
  weeklySpeed: 412.3,
  block: null,
  ...over,
});

describe("Dashboard card: kg/hour Jobs", () => {
  it("a row-count Job is unchanged", () => {
    render(<RowStemCard card={card()} />);
    expect(screen.getByText("412.3 stems/hour")).toBeInTheDocument();
    expect(screen.queryByText(/kg\/hour/)).not.toBeInTheDocument();
  });

  it("shows kg/hour with the kilograms, matched hours and bins behind it", () => {
    render(
      <RowStemCard
        card={card({
          scaleProductivity: { kgPerHour: 170.5, netKg: 270, matchedHours: 1.5833, weighedBins: 2, excludedBins: 1, binsNotYetWeighed: 1, reportingFrom: "2026-11-24" },
        })}
      />
    );
    expect(screen.getByText("170.5 kg/hour")).toBeInTheDocument();
    expect(screen.getByText("270 kg · 1.58 h picking · 2 bins")).toBeInTheDocument();
    expect(screen.getByText("1 bin not weighed yet · 1 bin to review")).toBeInTheDocument();
    expect(screen.queryByText(/stems\/hour/)).not.toBeInTheDocument();
  });

  it("waits (never 0) when no bin has been weighed", () => {
    render(
      <RowStemCard
        card={card({ scaleProductivity: { kgPerHour: null, netKg: 0, matchedHours: 0, weighedBins: 0, excludedBins: 0, binsNotYetWeighed: 2, reportingFrom: "2026-11-24" } })}
      />
    );
    expect(screen.getByText("Waiting for weighed bins")).toBeInTheDocument();
    expect(screen.getByText("None yet")).toBeInTheDocument();
    expect(screen.queryByText(/0\.0 kg/)).not.toBeInTheDocument();
  });
});

describe("TV slide: kg/hour Jobs", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1872);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(950);
  });
  const slide = (over: Partial<ActivitySlide>): ActivitySlide => ({
    activityId: "pick",
    activityName: "Picking Peppers",
    speedUnit: "kg/hour",
    target: 150,
    minimumActivityHours: 0,
    topN: null,
    slideSeconds: 15,
    atTargetColor: "#15803d",
    belowTargetColor: "#dc2626",
    status: "ok",
    reason: null,
    notice: null,
    employees: [{ displayName: "Ana Lopez", firstName: "Ana", lastInitial: "L.", speed: 170.5, activityHours: 1.58, quantityCounted: 270, binsCounted: 2 }],
    belowMinimumHours: 0,
    employeesWithoutSpeed: 0,
    computedAt: "2026-11-24T12:00:00Z",
    ...over,
  });
  const renderSlide = (s: ActivitySlide) => render(<TvRankingSlide item={{ kind: "activity", key: s.activityId, seconds: 15, slide: s }} />);

  it("same bar chart, kg/hr labels", () => {
    renderSlide(slide({}));
    expect(screen.getByText("171 kg/hr")).toBeInTheDocument();
  });

  it("waiting state when no weighed bins", () => {
    renderSlide(slide({ status: "no_speed", reason: "waiting_for_bins", notice: "Waiting for weighed bins: kilograms/hour appears as bins are weighed and credited.", employees: [] }));
    expect(screen.getByText("Waiting for weighed bins")).toBeInTheDocument();
  });
});
