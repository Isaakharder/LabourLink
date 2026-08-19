// @vitest-environment jsdom
//
// Covers the Stats page back button (top-left, same ChevronLeft + app-
// navigation Link pattern as SettingsScreen.tsx's own header) added so an
// Android APK/mobile-browser user can return to Home — where activity/row
// selection happens — without relying on the hardware/browser back button.
// Same React-Testing-Library + per-module vi.mock() convention as
// SettingsScreen.test.tsx.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatsScreen } from "./StatsScreen";

vi.mock("../../context/WorkSessionContext", () => ({
  useWorkSession: () => ({
    language: "en",
    handleApiError: () => false,
  }),
}));

vi.mock("../../lib/api", () => ({
  api: vi.fn(() => new Promise(() => {})), // never resolves — only the header/back button is under test here
}));

function renderStats() {
  return render(
    <MemoryRouter initialEntries={["/mobile/stats"]}>
      <Routes>
        <Route path="/mobile/stats" element={<StatsScreen />} />
        <Route path="/mobile/home" element={<div>Home Screen</div>} />
      </Routes>
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
});

describe("StatsScreen — back button", () => {
  it("renders a labeled back control at the top of the page, pointing at /mobile/home", () => {
    renderStats();
    const back = screen.getByRole("link", { name: /back to home/i });
    expect(back).toHaveAttribute("href", "/mobile/home");
  });

  it("puts the header at the top of .mobile-stats, matching SettingsScreen's own header placement", () => {
    const { container } = renderStats();
    const root = container.querySelector(".mobile-stats");
    expect(root!.firstElementChild).toHaveClass("mobile-settings-header");
  });

  it("returns to Home via app routing (a Link), not window.history, when tapped", async () => {
    const user = userEvent.setup();
    renderStats();
    await user.click(screen.getByRole("link", { name: /back to home/i }));
    expect(screen.getByText("Home Screen")).toBeInTheDocument();
  });
});
