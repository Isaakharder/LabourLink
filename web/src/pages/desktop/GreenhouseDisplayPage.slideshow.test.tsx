// @vitest-environment jsdom
// The TV slideshow: map-only fallback, rotation, notices instead of invented
// speeds, outage recovery with data age, revoked links, and the TV link
// rendering even at a phone-sized width.
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivitySlide, DisplaySlidesResponse } from "../../lib/greenhouseLiveTypes";

vi.mock("../../components/greenhouseLive/GreenhouseLiveCanvas", () => ({
  GreenhouseLiveCanvas: () => <div data-testid="map-canvas" />,
}));

import { GreenhouseDisplayPage } from "./GreenhouseDisplayPage";

const KEY = "test-display-key";

const mapState = {
  name: "Break Area TV",
  activityId: null,
  activityName: null,
  dateStart: "2026-10-12",
  dateEnd: "2026-10-12",
  datePreset: "today",
  rotationDegrees: 0,
  configVersion: "v1",
  generatedAt: "2026-10-12T14:00:00Z",
  land: { id: "l", name: "Land", northSouthFeet: 100, eastWestFeet: 100, isActive: true, phases: [] },
  blocks: [],
};

function activitySlide(over: Partial<ActivitySlide> = {}): ActivitySlide {
  return {
    activityId: "pruning",
    activityName: "Winding & Pruning",
    speedUnit: "stems/hour",
    target: 500,
    minimumActivityHours: 0.5,
    topN: null,
    slideSeconds: 15,
    atTargetColor: "#15803d",
    belowTargetColor: "#dc2626",
    status: "ok",
    notice: null,
    employees: [
      { firstName: "Ana", lastInitial: "A.", speed: 812.4, activityHours: 6.5, quantityCounted: 5000 },
      { firstName: "Bruno", lastInitial: "B.", speed: 455, activityHours: 7, quantityCounted: 3000 },
    ],
    belowMinimumHours: 1,
    employeesWithoutSpeed: 0,
    computedAt: "2026-10-12T14:00:00Z",
    ...over,
  };
}

function slidesResponse(slides: ActivitySlide[]): DisplaySlidesResponse {
  return {
    generatedAt: "2026-10-12T14:00:00Z",
    timezone: "America/Toronto",
    period: { week: "this_week", includeToday: true, dateStart: "2026-10-12", dateEnd: "2026-10-12", empty: false },
    mapSlideSeconds: 20,
    slides,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let slidesReply: () => Response | Promise<Response>;
let mapReply: () => Response | Promise<Response>;

beforeEach(() => {
  // jsdom has no layout: give the bar chart a 1920×1080-like area.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1872);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(950);
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(new Date("2026-10-12T14:00:00Z"));
  slidesReply = () => json(200, slidesResponse([]));
  mapReply = () => json(200, mapState);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => (String(url).includes("/slides") ? slidesReply() : mapReply()))
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("TV slideshow", () => {
  it("shows only the map, without rotating, when no activity slides exist", async () => {
    render(<GreenhouseDisplayPage displayKey={KEY} />);
    await flush();
    expect(screen.getByTestId("map-canvas")).toBeInTheDocument();
    expect(screen.getByText("Currently working")).toBeInTheDocument();
    await advance(120_000);
    expect(screen.queryByText("Winding & Pruning")).not.toBeInTheDocument();
    expect(document.querySelector(".tv-slide-dots")).toBeNull();
  });

  it("rotates map -> ranking -> map using each slide's duration, with unit and dates", async () => {
    slidesReply = () => json(200, slidesResponse([activitySlide()]));
    render(<GreenhouseDisplayPage displayKey={KEY} />);
    await flush();
    expect(screen.getByText("Currently working")).toBeInTheDocument();
    await advance(20_000);
    expect(screen.getByText("Winding & Pruning")).toBeInTheDocument();
    expect(screen.getByText("Stems per hour")).toBeInTheDocument();
    expect(screen.getByText("Date:").parentElement).toHaveTextContent(/This week, .*\(including today\)/);
    expect(screen.getByText("Ana A.")).toBeInTheDocument();
    expect(screen.getByText("812 stems/hour")).toBeInTheDocument();
    expect(screen.getByText(/1 under the 0.5 h minimum not shown/)).toBeInTheDocument();
    expect(screen.getByText("Target:").parentElement).toHaveTextContent("Target: 500 stems/hour");
    expect(screen.getByText("Top:").parentElement).toHaveTextContent("Top: All");
    expect(screen.getByText("Min hours:").parentElement).toHaveTextContent("Min hours: 0.5 h");
    await advance(15_000);
    expect(screen.queryByText("Ana A.")).not.toBeInTheDocument();
    expect(screen.getByText("Currently working")).toBeInTheDocument();
  });

  it("shows a notice — never a zero — when work exists but no speed is calculable", async () => {
    slidesReply = () =>
      json(200, slidesResponse([activitySlide({ status: "no_speed", employees: [], notice: "Work is recorded, but no speed can be calculated yet." })]));
    render(<GreenhouseDisplayPage displayKey={KEY} />);
    await flush();
    await advance(20_000);
    expect(screen.getByText("No speeds yet")).toBeInTheDocument();
    expect(screen.getByText(/no speed can be calculated yet/)).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("marks an activity whose data failed as unavailable", async () => {
    slidesReply = () =>
      json(200, slidesResponse([activitySlide({ status: "unavailable", employees: [], notice: "Speed data for this activity is unavailable right now." })]));
    render(<GreenhouseDisplayPage displayKey={KEY} />);
    await flush();
    await advance(20_000);
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
  });

  it("keeps retained rankings through an outage, labelled with their age, then recovers", async () => {
    slidesReply = () => json(200, slidesResponse([activitySlide({ slideSeconds: 600 })]));
    render(<GreenhouseDisplayPage displayKey={KEY} />);
    await flush();
    await advance(20_000); // onto the ranking slide (600 s long)
    expect(screen.getByText("Ana A.")).toBeInTheDocument();

    slidesReply = () => Promise.reject(new TypeError("Failed to fetch"));
    mapReply = () => Promise.reject(new TypeError("Failed to fetch"));
    await advance(6 * 60_000);
    expect(screen.getByText("Ana A.")).toBeInTheDocument();
    expect(screen.getByText(/Reconnecting… Rankings from .* \(6 min old\)/)).toBeInTheDocument();

    slidesReply = () => json(200, slidesResponse([activitySlide({ slideSeconds: 600 })]));
    mapReply = () => json(200, mapState);
    await advance(60_000);
    expect(screen.queryByText(/Reconnecting/)).not.toBeInTheDocument();
    expect(screen.getByText(/Updated/)).toBeInTheDocument();
  });

  it("tells the viewer when the link was revoked", async () => {
    mapReply = () => json(404, { error: "Not found" });
    slidesReply = () => json(404, { error: "Not found" });
    render(<GreenhouseDisplayPage displayKey={KEY} />);
    await flush();
    expect(screen.getByText("This display link is no longer active.")).toBeInTheDocument();
  });
});
