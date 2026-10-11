// @vitest-environment jsdom
// TV slide schedules (Display → Setup): the map as an optional slide, the
// "No slides scheduled right now" screen, and slides starting and stopping
// on their own at schedule boundaries — no manual refresh.
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

function slidesResponse(slides: ActivitySlide[], over: Partial<DisplaySlidesResponse> = {}): DisplaySlidesResponse {
  return {
    generatedAt: "2026-10-12T14:00:00Z",
    timezone: "America/Toronto",
    period: { week: "this_week", includeToday: true, dateStart: "2026-10-12", dateEnd: "2026-10-12", empty: false },
    mapSlideSeconds: 20,
    slides,
    ...over,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let slidesReply: () => Response | Promise<Response>;
let slidesCalls = 0;
let mapReply: () => Response | Promise<Response>;

beforeEach(() => {
  // jsdom has no layout: give the bar chart a 1920×1080-like area.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1872);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(950);
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(new Date("2026-10-12T14:00:00Z"));
  slidesReply = () => json(200, slidesResponse([]));
  slidesCalls = 0;
  mapReply = () => json(200, mapState);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/slides")) {
        slidesCalls++;
        return slidesReply();
      }
      return mapReply();
    })
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

describe("TV slide schedules", () => {
  it("map not sent to the TV: only the ranking slide, no map legend, no rotation", async () => {
    slidesReply = () => json(200, slidesResponse([activitySlide()], { mapEnabled: false }));
    render(<GreenhouseDisplayPage displayKey={KEY} />);
    await flush();
    expect(screen.getByText("Ana A.")).toBeInTheDocument();
    expect(screen.queryByText("Currently working")).not.toBeInTheDocument();
    await advance(45_000);
    expect(screen.getByText("Ana A.")).toBeInTheDocument();
    expect(document.querySelector(".tv-slide-dots")).toBeNull();
  });

  it("nothing scheduled: says so (no map), then resumes on its own when a schedule starts", async () => {
    const start = new Date("2026-10-12T14:05:00Z").toISOString(); // 5 minutes away
    // Like the server: nothing until 14:05, then the slide and the map.
    slidesReply = () =>
      Date.now() < Date.parse(start)
        ? json(200, slidesResponse([], { mapEnabled: false, nextScheduleChangeAt: start }))
        : json(200, slidesResponse([activitySlide()], { mapEnabled: true, nextScheduleChangeAt: null }));
    render(<GreenhouseDisplayPage displayKey={KEY} />);
    await flush();
    expect(screen.getByText("No slides scheduled right now")).toBeInTheDocument();
    expect(screen.queryByText("Currently working")).not.toBeInTheDocument();

    await advance(4 * 60_000 + 30_000); // regular polls keep the notice until then
    expect(screen.getByText("No slides scheduled right now")).toBeInTheDocument();
    const before = slidesCalls;
    await advance(31_500); // just past 14:05 — before the next regular poll (14:05:00 is also a poll tick)
    expect(slidesCalls).toBeGreaterThan(before);
    expect(screen.queryByText("No slides scheduled right now")).not.toBeInTheDocument();
    expect(screen.getByText("Currently working")).toBeInTheDocument();
    await advance(20_000);
    expect(screen.getByText("Ana A.")).toBeInTheDocument();
  });

  it("re-checks exactly at a schedule boundary between regular polls, and stops a slide whose schedule ended", async () => {
    const end = new Date("2026-10-12T14:00:30Z").toISOString(); // before the 60 s poll
    slidesReply = () => json(200, slidesResponse([activitySlide()], { mapEnabled: false, nextScheduleChangeAt: end }));
    render(<GreenhouseDisplayPage displayKey={KEY} />);
    await flush();
    expect(screen.getByText("Ana A.")).toBeInTheDocument();
    const before = slidesCalls;
    slidesReply = () => json(200, slidesResponse([], { mapEnabled: false, nextScheduleChangeAt: null }));
    await advance(31_500);
    expect(slidesCalls).toBe(before + 1);
    expect(screen.queryByText("Ana A.")).not.toBeInTheDocument();
    expect(screen.getByText("No slides scheduled right now")).toBeInTheDocument();
  });

  it("picks up saved Setup changes on the regular poll, without a refresh", async () => {
    render(<GreenhouseDisplayPage displayKey={KEY} />);
    await flush();
    expect(screen.getByText("Currently working")).toBeInTheDocument();
    slidesReply = () => json(200, slidesResponse([activitySlide()], { mapEnabled: false }));
    await advance(60_000);
    expect(screen.getByText("Ana A.")).toBeInTheDocument();
    expect(screen.queryByText("Currently working")).not.toBeInTheDocument();
  });

  it("an older server (no mapEnabled field) still shows the map first", async () => {
    slidesReply = () => json(200, slidesResponse([activitySlide()]));
    render(<GreenhouseDisplayPage displayKey={KEY} />);
    await flush();
    expect(screen.getByText("Currently working")).toBeInTheDocument();
  });
});
