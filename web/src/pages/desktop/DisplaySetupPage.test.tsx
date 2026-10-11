// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnsavedChangesProvider } from "../../context/UnsavedChangesContext";
import { DisplaySlidesConfig } from "../../lib/greenhouseLiveTypes";
import { DisplaySetupPage } from "./DisplaySetupPage";

const ALWAYS = { enabled: false, days: [1, 2, 3, 4, 5, 6, 7], start: "06:00", end: "18:00" };

const config: DisplaySlidesConfig = {
  reportWeek: "this_week",
  reportIncludeToday: true,
  mapSlideSeconds: 20,
  map: { sendToTv: true, schedule: ALWAYS },
  hiddenCards: [],
  timezone: "America/Toronto",
  period: { dateStart: "2026-10-12", dateEnd: "2026-10-12", empty: false },
  activities: [
    { activityId: "a-pick", name: "Picking Peppers", speedUnit: "stems/hour", densitySource: "stems", normalSpeed: 180, sendToTv: false, targetOverride: null, minimumActivityHours: 0, topN: null, slideSeconds: 15, atTargetColor: "#15803d", belowTargetColor: "#dc2626", schedule: ALWAYS },
    { activityId: "a-prune", name: "Winding & Pruning", speedUnit: "stems/hour", densitySource: "stems", normalSpeed: 500, sendToTv: true, targetOverride: null, minimumActivityHours: 0.5, topN: null, slideSeconds: 15, atTargetColor: "#15803d", belowTargetColor: "#dc2626", schedule: ALWAYS },
    { activityId: "a-clean", name: "Cleaning", speedUnit: "tasks/hour", densitySource: null, normalSpeed: null, sendToTv: false, targetOverride: null, minimumActivityHours: 0, topN: null, slideSeconds: 15, atTargetColor: "#15803d", belowTargetColor: "#dc2626", schedule: ALWAYS },
  ],
};

let puts: any[] = [];
let hiddenPuts: string[][] = [];
let hiddenFails = false;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  puts = [];
  hiddenPuts = [];
  hiddenFails = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/greenhouse/displays")) {
        return json(200, { displays: [{ id: "d1", name: "Break Area TV", isActive: true }] });
      }
      if (String(url).endsWith("/setup-hidden-cards") && init?.method === "PUT") {
        if (hiddenFails) return json(500, { error: "nope" });
        const body = JSON.parse(String(init.body));
        hiddenPuts.push(body.hiddenCards);
        return json(200, { hiddenCards: body.hiddenCards });
      }
      if (String(url).endsWith("/slides-config") && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        return json(200, {
          ...config,
          reportWeek: body.reportWeek,
          reportIncludeToday: body.reportIncludeToday,
          mapSlideSeconds: body.mapSlideSeconds,
          map: body.map ?? config.map,
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

  it("saves at/above and below target colours per activity", async () => {
    const user = userEvent.setup();
    renderPage();
    const card = (await screen.findByText("Winding & Pruning")).closest(".display-setup-card") as HTMLElement;
    expect(within(card).getByLabelText("At/above target colour")).toHaveValue("#15803d");
    expect(within(card).getByLabelText("Below target colour")).toHaveValue("#dc2626");
    fireEvent.input(within(card).getByLabelText("At/above target colour"), { target: { value: "#1d4ed8" } });
    fireEvent.change(within(card).getByLabelText("At/above target colour"), { target: { value: "#1d4ed8" } });
    fireEvent.input(within(card).getByLabelText("Below target colour"), { target: { value: "#f59e0b" } });
    fireEvent.change(within(card).getByLabelText("Below target colour"), { target: { value: "#f59e0b" } });
    await user.click(screen.getByRole("button", { name: "Save TV settings" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    const body = puts[0] as { activities: { activityId: string; atTargetColor: string; belowTargetColor: string }[] };
    expect(body.activities.find((a) => a.activityId === "a-prune")).toMatchObject({ atTargetColor: "#1d4ed8", belowTargetColor: "#f59e0b" });
    expect(body.activities.find((a) => a.activityId === "a-pick")).toMatchObject({ atTargetColor: "#15803d", belowTargetColor: "#dc2626" });
    // Re-read from the (mock) server response: still the saved colours.
    expect(await within(card).findByLabelText("At/above target colour")).toHaveValue("#1d4ed8");
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

const cardOf = async (name: string) => (await screen.findByRole("heading", { name, level: 3 })).closest(".display-setup-card") as HTMLElement;

describe("Display > Setup: Map card", () => {
  it("shows a Map card with Send to TV, slide duration and a schedule, linking to Display → Map for map settings", async () => {
    renderPage();
    const map = await cardOf("Map");
    expect(within(map).getByLabelText("Send to TV")).toBeChecked();
    expect(within(map).getByLabelText("Slide duration (s)")).toHaveValue(20);
    expect(within(map).getByRole("button", { name: "Schedule for Map" })).toBeInTheDocument();
    expect(within(map).getByText("Always shown")).toBeInTheDocument();
    expect(within(map).getByRole("link", { name: "Display → Map" })).toHaveAttribute("href", "/display/map");
  });

  it("saves the map's Send to TV and duration with the other settings", async () => {
    const user = userEvent.setup();
    renderPage();
    const map = await cardOf("Map");
    await user.click(within(map).getByLabelText("Send to TV"));
    await user.clear(within(map).getByLabelText("Slide duration (s)"));
    await user.type(within(map).getByLabelText("Slide duration (s)"), "30");
    await user.click(screen.getByRole("button", { name: "Save TV settings" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].map).toEqual({ sendToTv: false, schedule: ALWAYS });
    expect(puts[0].mapSlideSeconds).toBe(30);
  });
});

describe("Display > Setup: hide cards", () => {
  it("hides a card at once (saved per display) without changing what is sent to the TV, and Unhide all brings it back", async () => {
    const user = userEvent.setup();
    renderPage();
    const prune = await cardOf("Winding & Pruning");
    expect(within(prune).getByText("Page only — TV unaffected")).toBeInTheDocument();
    await user.click(within(prune).getByRole("button", { name: "Hide Winding & Pruning" }));
    await waitFor(() => expect(hiddenPuts).toEqual([["a-prune"]]));
    expect(screen.queryByRole("heading", { name: "Winding & Pruning" })).not.toBeInTheDocument();
    expect(screen.getByText("1 hidden on this page (1 still sent to TV)")).toBeInTheDocument();
    // Hiding isn't an unsaved setting, and the save body still sends it to the TV.
    expect(screen.getByRole("button", { name: "Save TV settings" })).toBeDisabled();
    expect(screen.getByText("1 sent to TV")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Unhide all" }));
    await waitFor(() => expect(hiddenPuts).toEqual([["a-prune"], []]));
    expect(await screen.findByRole("heading", { name: "Winding & Pruning" })).toBeInTheDocument();
    expect(puts).toEqual([]);
  });

  it("keeps cards hidden after reopening the page", async () => {
    vi.mocked(fetch).mockImplementation(async (url) =>
      String(url).endsWith("/api/greenhouse/displays")
        ? json(200, { displays: [{ id: "d1", name: "Break Area TV", isActive: true }] })
        : json(200, { ...config, hiddenCards: ["map", "a-clean"] })
    );
    renderPage();
    expect(await screen.findByRole("heading", { name: "Picking Peppers" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Map" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Cleaning" })).not.toBeInTheDocument();
    expect(screen.getByText("2 hidden on this page (1 still sent to TV)")).toBeInTheDocument();
  });

  it("brings a card back and says so if hiding can't be saved", async () => {
    hiddenFails = true;
    const user = userEvent.setup();
    renderPage();
    const pick = await cardOf("Picking Peppers");
    await user.click(within(pick).getByRole("button", { name: "Hide Picking Peppers" }));
    expect(await screen.findByText("Could not save which cards are hidden.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Picking Peppers" })).toBeInTheDocument();
  });
});

describe("Display > Setup: schedules", () => {
  it("defaults to Always show; a Mon–Fri 6 AM–6 PM schedule shows on the card and is saved", async () => {
    const user = userEvent.setup();
    renderPage();
    const pick = await cardOf("Picking Peppers");
    expect(within(pick).getByText("Always shown")).toBeInTheDocument();
    await user.click(within(pick).getByRole("button", { name: "Schedule for Picking Peppers" }));
    const dialog = screen.getByRole("dialog", { name: "Schedule for Picking Peppers" });
    expect(within(dialog).getByLabelText("Always show")).toBeChecked();
    expect(within(dialog).getByText(/organization's time zone \(America\/Toronto\)/)).toBeInTheDocument();
    await user.click(within(dialog).getByLabelText("Use schedule"));
    await user.click(within(dialog).getByRole("button", { name: "Mon–Fri" }));
    expect(within(dialog).getByText("Mon–Fri · 6:00 AM–6:00 PM")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(within(pick).getByText("Mon–Fri · 6:00 AM–6:00 PM")).toBeInTheDocument();
    expect(within(pick).getByRole("button", { name: "Schedule for Picking Peppers" })).toHaveClass("scheduled");
    await user.click(screen.getByRole("button", { name: "Save TV settings" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].activities.find((a: any) => a.activityId === "a-pick").schedule).toEqual({ enabled: true, days: [1, 2, 3, 4, 5], start: "06:00", end: "18:00" });
    // Other cards keep Always show.
    expect(puts[0].activities.find((a: any) => a.activityId === "a-prune").schedule).toEqual(ALWAYS);
  });

  it("an overnight schedule says it ends the next day", async () => {
    const user = userEvent.setup();
    renderPage();
    const map = await cardOf("Map");
    await user.click(within(map).getByRole("button", { name: "Schedule for Map" }));
    const dialog = screen.getByRole("dialog", { name: "Schedule for Map" });
    await user.click(within(dialog).getByLabelText("Use schedule"));
    for (const day of ["Mon", "Tue", "Wed", "Thu", "Sat", "Sun"]) await user.click(within(dialog).getByLabelText(day));
    fireEvent.change(within(dialog).getByLabelText("Start"), { target: { value: "22:00" } });
    fireEvent.change(within(dialog).getByLabelText("End"), { target: { value: "06:00" } });
    expect(within(dialog).getByText(/Ends the next day/)).toBeInTheDocument();
    expect(within(dialog).getByText("Fri · 10:00 PM–6:00 AM (next day)")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(within(map).getByText("Fri · 10:00 PM–6:00 AM (next day)")).toBeInTheDocument();
  });

  it("won't save a schedule with no days", async () => {
    const user = userEvent.setup();
    renderPage();
    const pick = await cardOf("Picking Peppers");
    await user.click(within(pick).getByRole("button", { name: "Schedule for Picking Peppers" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByLabelText("Use schedule"));
    for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) await user.click(within(dialog).getByLabelText(day));
    expect(within(dialog).getByText("Choose at least one day.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    await user.click(screen.getByRole("button", { name: "Save TV settings" }));
    expect(await screen.findByText("Picking Peppers: choose at least one day for the schedule.")).toBeInTheDocument();
    expect(puts).toEqual([]);
  });
});
