// @vitest-environment jsdom
//
// Display → Map phase checkboxes (GreenhousePage): one checkbox per phase of
// the selected land plus "Select all phases"; the preview draws only the
// checked phases; the selection is seeded from and published per display
// (null = all phases); at least one phase is required to publish; switching
// land resets to all phases. The canvas is replaced by a list of the phases
// it was given. Server side: greenhouseDisplays.mapPhases.test.ts.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GreenhousePage } from "./GreenhousePage";
import { api } from "../../lib/api";

vi.mock("../../components/greenhouseLive/GreenhouseLiveCanvas", () => ({
  GreenhouseLiveCanvas: ({ phases }: { phases: { id: string; name: string }[] }) => (
    <ul data-testid="map-canvas">
      {phases.map((p) => (
        <li key={p.id}>{p.name}</li>
      ))}
    </ul>
  ),
}));
vi.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ employee: { id: "admin", firstName: "Ada", lastName: "Admin", securityRole: "Administrator" } }),
}));
vi.mock("../../context/UnsavedChangesContext", () => ({ useUnsavedChangesGuard: () => ({ setUnsavedChanges: () => {} }) }));
vi.mock("../../lib/api", () => {
  class ApiError extends Error {
    status = 400;
  }
  return { ApiError, api: vi.fn() };
});

const phase = (id: string, name: string, x: number) => ({
  id,
  name,
  description: null,
  northSouthFeet: 100,
  eastWestFeet: 100,
  xFeetFromWest: x,
  yFeetFromNorth: 0,
  isActive: true,
  sortOrder: null,
  rows: [],
});
const LANDS = {
  "land-a": { id: "land-a", name: "Main Range", northSouthFeet: 100, eastWestFeet: 400, isActive: true, phases: [phase("p1", "Phase 1", 0), phase("p2", "Phase 2", 100), phase("p3", "Phase 3", 200)] },
  "land-b": { id: "land-b", name: "North Range", northSouthFeet: 100, eastWestFeet: 200, isActive: true, phases: [phase("q1", "North 1", 0)] },
} as const;

function display(id: string, name: string, phaseIds: string[] | null) {
  return {
    id,
    name,
    landId: "land-a",
    landName: "Main Range",
    activityId: null,
    activityName: null,
    dateStart: "2026-10-10",
    dateEnd: "2026-10-10",
    isActive: true,
    updatedAt: "2026-10-10T12:00:00Z",
    rotationDegrees: 0,
    datePreset: "today",
    effectiveDateStart: new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" }),
    effectiveDateEnd: new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" }),
    reportWeek: "current",
    reportIncludeToday: true,
    mapSlideSeconds: 30,
    phaseIds,
    tvToken: "tok",
  };
}

let displays: ReturnType<typeof display>[];
const putCalls = () =>
  vi.mocked(api).mock.calls.filter(([, o]) => (o as RequestInit | undefined)?.method === "PUT").map(([p, o]) => ({ path: p as string, body: JSON.parse((o as RequestInit).body as string) }));

beforeEach(() => {
  displays = [display("d-up", "Upstairs", ["p2"]), display("d-break", "Break Area TV", null)];
  vi.mocked(api).mockImplementation(((path: string, options?: RequestInit) => {
    const url = new URL(path, "http://t");
    if (url.pathname === "/api/greenhouse-layout/lands") {
      return Promise.resolve({ lands: Object.values(LANDS).map((l) => ({ id: l.id, name: l.name, isActive: true })) });
    }
    if (url.pathname === "/api/greenhouse/displays" && !options?.method) return Promise.resolve({ displays });
    if (url.pathname.startsWith("/api/greenhouse/displays/") && options?.method === "PUT") {
      const body = JSON.parse(options.body as string);
      const id = url.pathname.split("/").pop()!;
      const updated = { ...displays.find((d) => d.id === id)!, landId: body.landId, phaseIds: body.phaseIds, updatedAt: new Date().toISOString() };
      displays = displays.map((d) => (d.id === id ? updated : d));
      return Promise.resolve({ display: updated });
    }
    if (url.pathname === "/api/greenhouse/available-activities") return Promise.resolve({ activities: [] });
    if (url.pathname === "/api/greenhouse/live") {
      const land = LANDS[url.searchParams.get("landId") as keyof typeof LANDS];
      return Promise.resolve({ dateStart: "2026-10-10", dateEnd: "2026-10-10", activityId: null, generatedAt: new Date().toISOString(), land, blocks: [] });
    }
    return Promise.reject(new Error(`Unhandled mock api() call in test: ${path}`));
  }) as typeof api);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const canvasPhases = () => within(screen.getByTestId("map-canvas")).queryAllByRole("listitem").map((li) => li.textContent);
const box = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;
const publishButton = () => screen.getByRole("button", { name: /Publish to TV/ });

// Waits until the selected display (Upstairs, Phase 2 only) has seeded the
// checkboxes — there's one render between the displays loading and the seed.
async function renderPage(expectPhase1 = false) {
  render(<GreenhousePage />);
  await screen.findByRole("checkbox", { name: "Select all phases" });
  await waitFor(() => expect(box("Phase 1").checked).toBe(expectPhase1));
}

describe("Display → Map phase checkboxes", () => {
  it("replaces the phase dropdown with checkboxes and seeds a single-phase display", async () => {
    await renderPage();
    expect(screen.queryByRole("combobox", { name: /phase/i })).not.toBeInTheDocument();
    expect(box("Phase 2")).toBeChecked();
    expect(box("Phase 1")).not.toBeChecked();
    expect(box("Phase 3")).not.toBeChecked();
    expect(box("Select all phases")).not.toBeChecked();
    expect(box("Select all phases").indeterminate).toBe(true);
    expect(canvasPhases()).toEqual(["Phase 2"]);
    expect(screen.getByText(/· Phase 2$/)).toBeInTheDocument();
    expect(publishButton()).toBeDisabled(); // nothing changed yet
  });

  it("multiple phases: checking another shows both on the preview and publishes both for this display only", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(box("Phase 3"));
    expect(canvasPhases()).toEqual(["Phase 2", "Phase 3"]);
    await user.click(publishButton());
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(putCalls()[0].path).toBe("/api/greenhouse/displays/d-up");
    expect([...putCalls()[0].body.phaseIds].sort()).toEqual(["p2", "p3"]);
    expect(await screen.findByText("Published to Upstairs.")).toBeInTheDocument();
    expect(displays.find((d) => d.id === "d-break")!.phaseIds).toBeNull();
  });

  it("all phases: Select all checks every phase and publishes null (all, including future phases)", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(box("Select all phases"));
    expect(["Phase 1", "Phase 2", "Phase 3"].every((n) => box(n).checked)).toBe(true);
    expect(canvasPhases()).toEqual(["Phase 1", "Phase 2", "Phase 3"]);
    await user.click(publishButton());
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(putCalls()[0].body.phaseIds).toBeNull();
  });

  it("checking the last unchecked phase by hand also counts as all phases", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(box("Phase 1"));
    await user.click(box("Phase 3"));
    expect(box("Select all phases")).toBeChecked();
    await user.click(publishButton());
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(putCalls()[0].body.phaseIds).toBeNull();
  });

  it("requires at least one phase: clearing every phase blocks publishing with a message", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(box("Phase 2"));
    expect(canvasPhases()).toEqual([]);
    expect(screen.getByRole("alert")).toHaveTextContent("Select at least one phase to publish.");
    expect(publishButton()).toBeDisabled();
    expect(putCalls()).toHaveLength(0);
    await user.click(box("Select all phases"));
    await user.click(box("Select all phases"));
    expect(publishButton()).toBeDisabled();
  });

  it("saves per display and reloads: switching displays shows each display's own selection", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(box("Phase 1"));
    await user.click(publishButton());
    await waitFor(() => expect(putCalls()).toHaveLength(1));

    await user.selectOptions(screen.getByRole("combobox", { name: "Display" }), "d-break");
    await waitFor(() => expect(box("Select all phases")).toBeChecked());
    expect(canvasPhases()).toEqual(["Phase 1", "Phase 2", "Phase 3"]);

    cleanup();
    await renderPage(true); // fresh load from the saved displays (Upstairs now has Phase 1 too)
    await waitFor(() => expect(box("Phase 1")).toBeChecked());
    expect(box("Phase 2")).toBeChecked();
    expect(box("Phase 3")).not.toBeChecked();
    expect(canvasPhases()).toEqual(["Phase 1", "Phase 2"]);
  });

  it("switching land lists that land's phases, all selected", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.selectOptions(screen.getByRole("combobox", { name: "Land" }), "land-b");
    await waitFor(() => expect(box("North 1")).toBeChecked());
    expect(screen.queryByRole("checkbox", { name: "Phase 1" })).not.toBeInTheDocument();
    expect(box("Select all phases")).toBeChecked();
    expect(canvasPhases()).toEqual(["North 1"]);
  });
});
