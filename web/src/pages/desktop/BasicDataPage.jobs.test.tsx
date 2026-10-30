// @vitest-environment jsdom
//
// Basic data → Jobs (formerly the standalone Activities page): the route,
// the tab order and default tab, the /activities redirect (query and hash
// kept, Back/Forward unaffected), the unchanged Administrator-only editing,
// and the Jobs list's search, filters, add, edit, activate and deactivate.
// The other Basic data tabs are stubbed — they have their own tests.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Activity } from "../../lib/activityTypes";

let role = "Administrator";
vi.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ employee: { id: "emp-1", securityRole: role }, logout: vi.fn() }),
}));

vi.mock("./basic-data/BreaksTab", () => ({ BreaksTab: () => <p>Breaks content</p> }));
vi.mock("./basic-data/RowsTab", () => ({ RowsTab: () => <p>Rows content</p> }));
vi.mock("./basic-data/EmployeeBlocksTab", () => ({ EmployeeBlocksTab: () => <p>Employee Blocks content</p> }));
vi.mock("./basic-data/DensityTab", () => ({ DensityTab: () => <p>Density content</p> }));
vi.mock("./basic-data/VarietiesTab", () => ({ VarietiesTab: () => <p>Varieties content</p> }));
vi.mock("./basic-data/CarriersTab", () => ({ CarriersTab: () => <p>Carriers content</p> }));

function makeJob(overrides: Partial<Activity> = {}): Activity {
  return {
    id: "act-1",
    name: "Picking Peppers",
    normalSpeed: 300,
    speedUnit: "stems/hour",
    minimumDurationMinutes: 5,
    isActive: true,
    densitySource: "stems",
    assignedEmployeeCount: 2,
    updatedAt: "2026-08-01T00:00:00.000Z",
    questions: [{ id: "q-1", questionType: "greenhouse_row", label: "Where?", isRequired: true, sortOrder: 0 }],
    ...overrides,
  } as Activity;
}

let jobs: Activity[] = [];
let calls: { path: string; method: string; body: unknown }[] = [];

vi.mock("../../lib/api", () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    ApiError,
    onSessionExpired: vi.fn(() => () => {}),
    api: vi.fn((path: string, options?: RequestInit) => {
      const method = options?.method ?? "GET";
      calls.push({ path, method, body: options?.body ? JSON.parse(options.body as string) : null });
      if (path.startsWith("/api/activities") && method === "GET") {
        const params = new URLSearchParams(path.split("?")[1] ?? "");
        const status = params.get("status");
        const search = (params.get("search") ?? "").toLowerCase();
        return Promise.resolve({
          activities: jobs.filter(
            (j) =>
              (status === "all" || (status === "inactive" ? !j.isActive : j.isActive)) &&
              j.name.toLowerCase().includes(search)
          ),
        });
      }
      if (path.startsWith("/api/activities") && (method === "POST" || method === "PATCH")) {
        return Promise.resolve({ ok: true });
      }
      return Promise.reject(new ApiError(404, `Unhandled path in test: ${path}`));
    }),
  };
});

import { BasicDataPage } from "./BasicDataPage";
import { LegacyActivitiesRedirect } from "./LegacyActivitiesRedirect";

let navigateRef: ReturnType<typeof useNavigate> | null = null;
function LocationProbe() {
  const location = useLocation();
  navigateRef = useNavigate();
  return <output data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</output>;
}

function renderAt(entries: string[], index?: number) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={index ?? entries.length - 1}>
      <LocationProbe />
      <Routes>
        <Route path="dashboard" element={<p>Dashboard content</p>} />
        <Route path="activities/*" element={<LegacyActivitiesRedirect />} />
        <Route path="basic-data/*" element={<BasicDataPage />} />
      </Routes>
    </MemoryRouter>
  );
}

const location = () => screen.getByTestId("location").textContent;
const tabNav = () => screen.getByRole("navigation", { name: "Basic data sections" });

beforeEach(() => {
  role = "Administrator";
  jobs = [
    makeJob(),
    makeJob({ id: "act-2", name: "Winding & Pruning", densitySource: null, speedUnit: "plants/hour", questions: [] }),
    makeJob({ id: "act-3", name: "Packing Bags", isActive: false, normalSpeed: null, speedUnit: null, densitySource: null, questions: [] }),
  ];
  calls = [];
  navigateRef = null;
});

afterEach(() => cleanup());

describe("Basic data → Jobs route", () => {
  it("lists Jobs as the first tab, before Breaks, and opens on it from /basic-data", async () => {
    renderAt(["/basic-data"]);
    await waitFor(() => expect(location()).toBe("/basic-data/jobs"));
    const labels = within(tabNav()).getAllByRole("link").map((a) => a.textContent);
    expect(labels).toEqual(["Jobs", "Breaks", "Rows", "Employee Blocks", "Density", "Varieties", "Carriers"]);
    const jobsTab = within(tabNav()).getByRole("link", { name: "Jobs" });
    expect(jobsTab).toHaveAttribute("href", "/basic-data/jobs");
    expect(jobsTab).toHaveClass("tab", "tab-active");
    expect(jobsTab).toHaveAttribute("aria-current", "page");
    expect(within(tabNav()).getByRole("link", { name: "Breaks" })).not.toHaveClass("tab-active");
  });

  it("renders the Jobs list on a direct load of /basic-data/jobs", async () => {
    renderAt(["/basic-data/jobs"]);
    expect((await screen.findAllByText("Picking Peppers")).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Basic data" })).toBeInTheDocument();
    expect(screen.getByText("2 jobs")).toBeInTheDocument();
    expect(location()).toBe("/basic-data/jobs");
  });

  it("an unknown Basic data path falls back to Jobs", async () => {
    renderAt(["/basic-data/nonsense"]);
    await waitFor(() => expect(location()).toBe("/basic-data/jobs"));
  });
});

describe("/activities bookmarks", () => {
  it("redirects /activities to /basic-data/jobs, keeping the query string and hash", async () => {
    renderAt(["/activities?status=inactive&search=pack#top"]);
    await waitFor(() => expect(location()).toBe("/basic-data/jobs?status=inactive&search=pack#top"));
    expect(within(tabNav()).getByRole("link", { name: "Jobs" })).toHaveClass("tab-active");
  });

  it("sends the removed Activity Groups pages to Jobs (old bookmarks and the interim tab)", async () => {
    renderAt(["/activities/groups"]);
    await waitFor(() => expect(location()).toBe("/basic-data/jobs"));
    cleanup();
    renderAt(["/basic-data/activity-groups"]);
    await waitFor(() => expect(location()).toBe("/basic-data/jobs"));
    expect(screen.queryByRole("link", { name: "Activity Groups" })).not.toBeInTheDocument();
  });

  it("redirects any other old /activities/... address to Jobs", async () => {
    renderAt(["/activities/whatever"]);
    await waitFor(() => expect(location()).toBe("/basic-data/jobs"));
  });

  it("replaces the old entry, so Back returns to the previous page and Forward comes back to Jobs", async () => {
    renderAt(["/dashboard", "/activities"]);
    await waitFor(() => expect(location()).toBe("/basic-data/jobs"));
    navigateRef!(-1);
    await waitFor(() => expect(location()).toBe("/dashboard"));
    navigateRef!(1);
    await waitFor(() => expect(location()).toBe("/basic-data/jobs"));
  });

  it("Back and Forward move between Basic data tabs normally", async () => {
    const user = userEvent.setup();
    renderAt(["/basic-data/jobs"]);
    await screen.findAllByText("Picking Peppers");
    await user.click(within(tabNav()).getByRole("link", { name: "Breaks" }));
    expect(location()).toBe("/basic-data/breaks");
    expect(within(tabNav()).getByRole("link", { name: "Breaks" })).toHaveClass("tab-active");
    navigateRef!(-1);
    await waitFor(() => expect(location()).toBe("/basic-data/jobs"));
    expect(within(tabNav()).getByRole("link", { name: "Jobs" })).toHaveClass("tab-active");
    navigateRef!(1);
    await waitFor(() => expect(location()).toBe("/basic-data/breaks"));
  });
});

describe("Jobs permissions (unchanged from the Activities page)", () => {
  it("an Administrator can add, edit and deactivate Jobs", async () => {
    renderAt(["/basic-data/jobs"]);
    await screen.findAllByText("Picking Peppers");
    expect(screen.getByRole("button", { name: "Add Job" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Edit" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Deactivate" }).length).toBeGreaterThan(0);
  });

  it.each(["Manager", "Supervisor"])("a %s can view Jobs and their questions but not change them", async (r) => {
    role = r;
    renderAt(["/basic-data/jobs"]);
    await screen.findAllByText("Picking Peppers");
    expect(screen.queryByRole("button", { name: "Add Job" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^(Deactivate|Activate)$/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Job Questions" }).length).toBeGreaterThan(0);
  });
});

describe("Jobs list", () => {
  it("searches by Job name and filters by status", async () => {
    const user = userEvent.setup();
    renderAt(["/basic-data/jobs"]);
    await screen.findAllByText("Picking Peppers");
    await user.type(screen.getByPlaceholderText("Search by job name"), "wind");
    await waitFor(() => expect(screen.getByText("1 job")).toBeInTheDocument());
    expect(screen.queryByText("Picking Peppers")).not.toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/activities?search=wind&status=active")).toBe(true);

    await user.clear(screen.getByPlaceholderText("Search by job name"));
    await user.selectOptions(screen.getByRole("combobox"), "inactive");
    expect((await screen.findAllByText("Packing Bags")).length).toBeGreaterThan(0);
    expect(screen.getByText("1 job")).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox"), "all");
    await waitFor(() => expect(screen.getByText("3 jobs")).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText("Search by job name"), "zzz");
    expect(await screen.findByText("No jobs match these filters.")).toBeInTheDocument();
  });

  it("adds a Job with every setting: speed, unit, minimum duration, active and a row question", async () => {
    const user = userEvent.setup();
    renderAt(["/basic-data/jobs"]);
    await screen.findAllByText("Picking Peppers");
    await user.click(screen.getByRole("button", { name: "Add Job" }));
    const dialog = screen.getByRole("dialog", { name: "Add Job" });

    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(within(dialog).getByText("Job name is required")).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText(/^Job name \*/), "Plant Lowering");
    await user.type(within(dialog).getByLabelText("Normal speed"), "120");
    await user.type(within(dialog).getByLabelText("Speed unit"), "plants/hour");
    const minimum = within(dialog).getByLabelText("Minimum duration (minutes) *");
    await user.clear(minimum);
    await user.type(minimum, "3");
    await user.click(within(dialog).getByRole("button", { name: "Add Question" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe("/api/activities");
    expect(post?.body).toMatchObject({
      name: "Plant Lowering",
      normalSpeed: 120,
      speedUnit: "plants/hour",
      densitySource: null,
      minimumDurationMinutes: 3,
      isActive: true,
      questions: [expect.objectContaining({ questionType: "greenhouse_row", isRequired: true })],
    });
  });

  it("edits a Job, prefilled with its existing settings and questions", async () => {
    const user = userEvent.setup();
    renderAt(["/basic-data/jobs"]);
    await screen.findAllByText("Picking Peppers");
    await user.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const dialog = screen.getByRole("dialog", { name: "Edit Job" });
    expect(within(dialog).getByLabelText("Job name *")).toHaveValue("Picking Peppers");
    expect(within(dialog).getByLabelText("Normal speed")).toHaveValue(300);
    expect(within(dialog).getByLabelText("Density source")).toHaveValue("stems");
    expect(within(dialog).getByLabelText("Minimum duration (minutes) *")).toHaveValue(5);
    expect(within(dialog).getByDisplayValue("Where?")).toBeInTheDocument();

    const minimum = within(dialog).getByLabelText("Minimum duration (minutes) *");
    await user.clear(minimum);
    await user.type(minimum, "8");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.path).toBe("/api/activities/act-1");
    expect(patch?.body).toMatchObject({ name: "Picking Peppers", minimumDurationMinutes: 8, densitySource: "stems" });
  });

  it("opens a Job's questions under the Job wording", async () => {
    const user = userEvent.setup();
    renderAt(["/basic-data/jobs"]);
    await screen.findAllByText("Picking Peppers");
    await user.click(screen.getAllByRole("button", { name: "Job Questions" })[0]);
    expect(screen.getByRole("dialog", { name: "Job Questions — Picking Peppers" })).toBeInTheDocument();
  });

  it("deactivates after confirmation and activates an inactive Job directly", async () => {
    const user = userEvent.setup();
    renderAt(["/basic-data/jobs"]);
    await screen.findAllByText("Picking Peppers");
    await user.click(screen.getAllByRole("button", { name: "Deactivate" })[0]);
    const dialog = screen.getByRole("dialog", { name: "Deactivate job?" });
    expect(within(dialog).getByText(/will no longer appear in the mobile job picker/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Deactivate" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.find((c) => c.method === "PATCH")).toMatchObject({ path: "/api/activities/act-1", body: { isActive: false } });

    calls = [];
    await user.selectOptions(screen.getByRole("combobox"), "inactive");
    await screen.findAllByText("Packing Bags");
    await user.click(screen.getAllByRole("button", { name: "Activate" })[0]);
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")).toMatchObject({ path: "/api/activities/act-3", body: { isActive: true } })
    );
  });
});
