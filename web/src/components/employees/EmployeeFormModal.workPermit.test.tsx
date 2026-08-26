// @vitest-environment jsdom
//
// Covers the Work Permit fields on the employee form: the "Notify me
// before" selector defaults to 6 months once an expiry date is entered
// (client-side half of the server-enforced default — see
// workPermits.routes.test.ts for the server-side proof), switching to
// Custom reveals the days input, and the submit payload carries the right
// shape for both the preset and custom cases.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmployeeFormModal } from "./EmployeeFormModal";

const postCalls: { path: string; body: unknown }[] = [];

vi.mock("../../lib/api", () => {
  class ApiError extends Error {
    status: number;
    errors?: Record<string, string>;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    ApiError,
    api: vi.fn((path: string, options?: RequestInit) => {
      if (path.startsWith("/api/activity-groups")) return Promise.resolve({ activityGroups: [] });
      if (path.startsWith("/api/break-profiles")) return Promise.resolve({ breakProfiles: [] });
      if (path === "/api/employees" && options?.method === "POST") {
        postCalls.push({ path, body: JSON.parse(options.body as string) });
        return Promise.resolve({
          employee: { id: "new-emp", activityGroups: [], firstName: "Jordan", lastName: "Doe", device: null },
        });
      }
      return Promise.reject(new Error(`Unhandled mock api() call in test: ${path}`));
    }),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  postCalls.length = 0;
});

async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/First name/), "Jordan");
  await user.type(screen.getByLabelText(/Last name/), "Doe");
  await user.type(screen.getByLabelText(/Start date/), "2026-01-01");
  await user.selectOptions(screen.getByLabelText(/Nationality/), "Canadian");
}

describe("EmployeeFormModal — Work Permit fields", () => {
  it("hides the 'Notify me before' selector until an expiry date is entered", () => {
    render(<EmployeeFormModal employee={null} onClose={() => {}} onSaved={() => {}} />);
    expect(screen.queryByLabelText(/Notify me before/)).not.toBeInTheDocument();
  });

  it("defaults 'Notify me before' to 6 months the moment an expiry date is entered on a new employee", async () => {
    const user = userEvent.setup();
    render(<EmployeeFormModal employee={null} onClose={() => {}} onSaved={() => {}} />);
    await user.type(screen.getByLabelText(/Work Permit Expiry Date/), "2027-02-25");

    const leadSelect = screen.getByLabelText(/Notify me before/) as HTMLSelectElement;
    expect(leadSelect.value).toBe("6");
  });

  it("switching to Custom reveals the days input, and hides it again when switching back", async () => {
    const user = userEvent.setup();
    render(<EmployeeFormModal employee={null} onClose={() => {}} onSaved={() => {}} />);
    await user.type(screen.getByLabelText(/Work Permit Expiry Date/), "2027-02-25");

    expect(screen.queryByLabelText(/Custom lead time/)).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/Notify me before/), "custom");
    expect(screen.getByLabelText(/Custom lead time/)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(/Notify me before/), "3");
    expect(screen.queryByLabelText(/Custom lead time/)).not.toBeInTheDocument();
  });

  it("submits workPermitNotifyLeadMonths for a preset choice", async () => {
    const user = userEvent.setup();
    render(<EmployeeFormModal employee={null} onClose={() => {}} onSaved={() => {}} />);
    await fillRequiredFields(user);
    await user.type(screen.getByLabelText(/Work Permit Expiry Date/), "2027-02-25");
    await user.selectOptions(screen.getByLabelText(/Notify me before/), "3");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(postCalls.length).toBe(1);
    expect(postCalls[0].body).toMatchObject({ workPermitExpiryDate: "2027-02-25", workPermitNotifyLeadMonths: 3 });
    expect((postCalls[0].body as Record<string, unknown>).workPermitNotifyLeadDays).toBeUndefined();
  });

  it("submits workPermitNotifyLeadDays for a custom choice", async () => {
    const user = userEvent.setup();
    render(<EmployeeFormModal employee={null} onClose={() => {}} onSaved={() => {}} />);
    await fillRequiredFields(user);
    await user.type(screen.getByLabelText(/Work Permit Expiry Date/), "2027-02-25");
    await user.selectOptions(screen.getByLabelText(/Notify me before/), "custom");
    await user.type(screen.getByLabelText(/Custom lead time/), "45");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(postCalls.length).toBe(1);
    expect(postCalls[0].body).toMatchObject({ workPermitExpiryDate: "2027-02-25", workPermitNotifyLeadDays: 45 });
    expect((postCalls[0].body as Record<string, unknown>).workPermitNotifyLeadMonths).toBeUndefined();
  });

  it("rejects an out-of-range custom day count client-side, without submitting", async () => {
    const user = userEvent.setup();
    render(<EmployeeFormModal employee={null} onClose={() => {}} onSaved={() => {}} />);
    await fillRequiredFields(user);
    await user.type(screen.getByLabelText(/Work Permit Expiry Date/), "2027-02-25");
    await user.selectOptions(screen.getByLabelText(/Notify me before/), "custom");
    await user.type(screen.getByLabelText(/Custom lead time/), "0");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/between 1 and 3650/)).toBeInTheDocument();
    expect(postCalls.length).toBe(0);
  });

  it("submits workPermitExpiryDate: null and omits lead fields when no expiry date is entered", async () => {
    const user = userEvent.setup();
    render(<EmployeeFormModal employee={null} onClose={() => {}} onSaved={() => {}} />);
    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(postCalls.length).toBe(1);
    const body = postCalls[0].body as Record<string, unknown>;
    expect(body.workPermitExpiryDate).toBeNull();
    expect(body.workPermitNotifyLeadMonths).toBeUndefined();
    expect(body.workPermitNotifyLeadDays).toBeUndefined();
  });
});
