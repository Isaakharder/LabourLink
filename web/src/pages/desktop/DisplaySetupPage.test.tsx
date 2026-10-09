// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnsavedChangesProvider } from "../../context/UnsavedChangesContext";
import { DisplaySlidesConfig } from "../../lib/greenhouseLiveTypes";
import { DisplaySetupPage } from "./DisplaySetupPage";

const config: DisplaySlidesConfig = {
  reportWeek: "this_week",
  reportIncludeToday: true,
  mapSlideSeconds: 20,
  period: { dateStart: "2026-10-12", dateEnd: "2026-10-12", empty: false },
  activities: [
    { activityId: "a-pick", name: "Picking Peppers", speedUnit: "stems/hour", densitySource: "stems", normalSpeed: 180, sendToTv: false, targetOverride: null, minimumActivityHours: 0, topN: null, slideSeconds: 15 },
    { activityId: "a-prune", name: "Winding & Pruning", speedUnit: "stems/hour", densitySource: "stems", normalSpeed: 500, sendToTv: true, targetOverride: null, minimumActivityHours: 0.5, topN: null, slideSeconds: 15 },
    { activityId: "a-clean", name: "Cleaning", speedUnit: "tasks/hour", densitySource: null, normalSpeed: null, sendToTv: false, targetOverride: null, minimumActivityHours: 0, topN: null, slideSeconds: 15 },
  ],
};

let puts: unknown[] = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  puts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/greenhouse/displays")) {
        return json(200, { displays: [{ id: "d1", name: "Break Area TV", isActive: true }] });
      }
      if (String(url).endsWith("/slides-config") && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        return json(200, {
          ...config,
          reportWeek: body.reportWeek,
          reportIncludeToday: body.reportIncludeToday,
          mapSlideSeconds: body.mapSlideSeconds,
          activities: config.activities.map((a) => ({ ...a, ...body.activities.find((b: { activityId: string }) => b.activityId === a.activityId) })),
        });
      }
      if (String(url).endsWith("/slides-config")) return json(200, config);
      return json(404, {});
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPage() {
  return render(
    <MemoryRouter>
      <UnsavedChangesProvider>
        <DisplaySetupPage />
      </UnsavedChangesProvider>
    </MemoryRouter>
  );
}

describe("Display > Setup", () => {
  it("lists every active activity with its unit, and explains activities without a speed", async () => {
    renderPage();
    expect(await screen.findByText("Picking Peppers")).toBeInTheDocument();
    expect(screen.getByText("Winding & Pruning")).toBeInTheDocument();
    expect(screen.getAllByText("Speed: stems/hour")).toHaveLength(2);
    expect(screen.getByText(/No speed calculation for this activity/)).toBeInTheDocument();
    expect(screen.getByText("1 sent to TV")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("500 (normal speed)")).toBeInTheDocument();
  });

  it("saves the Send to TV checkbox, a display-only target, Top N and the period server-side", async () => {
    const user = userEvent.setup();
    renderPage();
    const card = (await screen.findByText("Picking Peppers")).closest(".display-setup-card") as HTMLElement;
    await user.click(within(card).getByLabelText("Send to TV"));
    const target = within(card).getByPlaceholderText("180 (normal speed)");
    await user.type(target, "1200");
    await user.selectOptions(within(card).getByRole("combobox"), "top");
    await user.click(screen.getByLabelText("Last week"));
    await user.click(screen.getByRole("button", { name: "Save TV settings" }));

    await waitFor(() => expect(puts).toHaveLength(1));
    const body = puts[0] as { reportWeek: string; activities: { activityId: string; sendToTv: boolean; targetOverride: number | null; topN: number | null }[] };
    expect(body.reportWeek).toBe("last_week");
    const pick = body.activities.find((a) => a.activityId === "a-pick")!;
    expect(pick).toMatchObject({ sendToTv: true, targetOverride: 1200, topN: 10 });
    const prune = body.activities.find((a) => a.activityId === "a-prune")!;
    expect(prune).toMatchObject({ sendToTv: true, targetOverride: null });
    expect(await screen.findByText(/Saved\. The TV picks this up/)).toBeInTheDocument();
    expect(screen.getByText("2 sent to TV")).toBeInTheDocument();
  });

  it("rejects an invalid slide duration before sending anything", async () => {
    const user = userEvent.setup();
    renderPage();
    const card = (await screen.findByText("Cleaning")).closest(".display-setup-card") as HTMLElement;
    const seconds = within(card).getByLabelText("Slide duration (s)");
    await user.clear(seconds);
    await user.type(seconds, "2");
    await user.click(screen.getByRole("button", { name: "Save TV settings" }));
    expect(await screen.findByText(/Cleaning: slide duration must be 5–600 seconds/)).toBeInTheDocument();
    expect(puts).toHaveLength(0);
  });
});
