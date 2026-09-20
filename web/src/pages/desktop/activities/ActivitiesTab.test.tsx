// @vitest-environment jsdom
//
// Tests the "Deactivate activity?" ConfirmDialog that replaced the
// window.confirm() popup previously used by handleToggleActive (see
// ActivitiesTab.tsx). lib/api.ts is mocked so every network call — the
// admin auth check, the activities list, and the deactivate PATCH — is
// fully controlled by the test, same convention as InputsPage.switching.test.tsx.
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivitiesTab } from "./ActivitiesTab";
import { AuthProvider } from "../../../context/AuthContext";
import { ApiError } from "../../../lib/api";
import { Activity } from "../../../lib/activityTypes";

afterEach(() => {
  cleanup();
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeActivity(overrides: Partial<Activity> = {}): Activity {
  return {
    id: "act-1",
    name: "Harvesting",
    normalSpeed: null,
    speedUnit: null,
    minimumDurationMinutes: 5,
    isActive: true,
    densitySource: null,
    assignedGroupCount: 0,
    updatedAt: "2026-08-01T00:00:00.000Z",
    questions: [],
    ...overrides,
  };
}

let activitiesResponse: { activities: Activity[] } = { activities: [makeActivity()] };
let patchDeferred: Deferred<unknown> | null = null;
let patchCalls: { path: string; body: unknown }[] = [];

vi.mock("../../../lib/api", () => {
  // Declared inside the factory — vi.mock is hoisted above the file's own
  // top-level declarations, so a module-scope class referenced here would
  // throw "Cannot access before initialization" (same convention as
  // InputsPage.switching.test.tsx's own mock).
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
      if (path.startsWith("/api/auth/me")) {
        return Promise.resolve({
          employee: { id: "emp-1", firstName: "Ada", lastName: "Admin", securityRole: "Administrator", teamRole: "Admin" },
        });
      }
      if (path.startsWith("/api/activities") && (!options?.method || options.method === "GET")) {
        return Promise.resolve(activitiesResponse);
      }
      if (path.startsWith("/api/activities/") && options?.method === "PATCH") {
        patchCalls.push({ path, body: options.body ? JSON.parse(options.body as string) : null });
        patchDeferred = createDeferred<unknown>();
        return patchDeferred.promise;
      }
      return Promise.reject(new ApiError(404, `Unhandled path in test: ${path}`));
    }),
  };
});

function renderTab() {
  return render(
    <AuthProvider>
      <ActivitiesTab />
    </AuthProvider>
  );
}

// Both the desktop <table> row and the mobile <div class="employee-cards">
// row render simultaneously (CSS, not JS, decides which shows) — every
// query below scopes to the first ("Deactivate"/"Cancel" etc. otherwise
// matches twice).
function firstDeactivateButton() {
  return screen.getAllByRole("button", { name: "Deactivate" })[0];
}

beforeEach(() => {
  activitiesResponse = { activities: [makeActivity()] };
  patchDeferred = null;
  patchCalls = [];
});

describe("ActivitiesTab deactivate confirmation", () => {
  it("opens the ConfirmDialog (not window.confirm) when Deactivate is clicked, focused inside it", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm");
    renderTab();

    await screen.findAllByText("Harvesting");
    await user.click(firstDeactivateButton());

    const dialog = await screen.findByRole("dialog", { name: "Deactivate activity?" });
    expect(within(dialog).getByText(/"Harvesting" will no longer appear in the mobile activity picker/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Historical time entries will not be affected\./)).toBeInTheDocument();
    // Initial focus lands on Cancel (the safe action), inside the dialog.
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("Cancel closes the dialog without calling the API", async () => {
    const user = userEvent.setup();
    renderTab();

    await screen.findAllByText("Harvesting");
    const trigger = firstDeactivateButton();
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Deactivate activity?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(patchCalls).toHaveLength(0);
    // Focus returns to the button that opened the dialog.
    expect(trigger).toHaveFocus();
  });

  it("Escape closes the dialog without calling the API", async () => {
    const user = userEvent.setup();
    renderTab();

    await screen.findAllByText("Harvesting");
    await user.click(firstDeactivateButton());
    await screen.findByRole("dialog", { name: "Deactivate activity?" });

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(patchCalls).toHaveLength(0);
  });

  it("Deactivate sends the PATCH, disables both buttons with a loading label while in flight, and closes only on success", async () => {
    const user = userEvent.setup();
    renderTab();

    await screen.findAllByText("Harvesting");
    await user.click(firstDeactivateButton());
    const dialog = await screen.findByRole("dialog", { name: "Deactivate activity?" });

    await user.click(within(dialog).getByRole("button", { name: "Deactivate" }));

    expect(patchCalls).toEqual([{ path: "/api/activities/act-1", body: { isActive: false } }]);
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Deactivating…" })).toBeDisabled();
    // Still open — the request hasn't resolved yet.
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    activitiesResponse = { activities: [makeActivity({ isActive: false })] };
    await act(async () => {
      patchDeferred!.resolve({});
    });

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps the dialog open and shows the error on failure, without a duplicate request on a second click", async () => {
    const user = userEvent.setup();
    renderTab();

    await screen.findAllByText("Harvesting");
    await user.click(firstDeactivateButton());
    const dialog = await screen.findByRole("dialog", { name: "Deactivate activity?" });

    await user.click(within(dialog).getByRole("button", { name: "Deactivate" }));
    expect(patchCalls).toHaveLength(1);

    // A second click while the first request is still in flight must not
    // fire a duplicate PATCH — the button is disabled, and the handler
    // itself also guards on `deactivating`.
    await user.click(within(dialog).getByRole("button", { name: "Deactivating…" }));
    expect(patchCalls).toHaveLength(1);

    await act(async () => {
      patchDeferred!.reject(new ApiError(500, "Could not update activity"));
    });

    await waitFor(() => expect(within(dialog).getByText("Could not update activity")).toBeInTheDocument());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Deactivate" })).not.toBeDisabled();

    // Retrying now is allowed and fires exactly one more request.
    await user.click(within(dialog).getByRole("button", { name: "Deactivate" }));
    expect(patchCalls).toHaveLength(2);
  });
});
