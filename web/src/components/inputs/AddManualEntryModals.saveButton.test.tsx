// @vitest-environment jsdom
//
// Add activity / Add work start submit buttons must use .employee-form-save,
// the shared primary-button class. The toolbar class .employees-add-button
// loses its background to `.employee-form-actions button` in this footer and
// renders white-on-white (same fix and reasoning as AddBreakModal.test.tsx's
// "keeps the Add Break button readable").
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddActivityModal } from "./AddActivityModal";
import { AddWorkStartModal } from "./AddWorkStartModal";

vi.mock("../../lib/api", () => {
  class ApiError extends Error {}
  return {
    ApiError,
    api: vi.fn((path: string) => {
      if (path.startsWith("/api/inputs/employee-activities")) return Promise.resolve({ activities: [] });
      if (path === "/api/inputs/greenhouse-rows") return Promise.resolve({ lands: [] });
      if (path === "/api/inputs/carriers") return Promise.resolve({ carriers: [] });
      return Promise.reject(new Error(`Unhandled mock api() call in test: ${path}`));
    }),
  };
});

afterEach(cleanup);

const props = { employeeId: "emp-1", employeeName: "Khen Lagto", date: "2026-10-05", onClose: () => {}, onCreated: () => {} };

describe("Inputs manual-entry modals: readable primary Save button", () => {
  it.each([
    ["Add Activity", () => <AddActivityModal {...props} />],
    ["Add Work Start", () => <AddWorkStartModal {...props} />],
  ])("%s uses employee-form-save, not employees-add-button", async (label, renderModal) => {
    render(renderModal());
    const button = await screen.findByRole("button", { name: label });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent(label);
    expect(button).toHaveClass("employee-form-save");
    expect(button).not.toHaveClass("employees-add-button");
  });
});
