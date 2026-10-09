// @vitest-environment jsdom
// The TV link must render the TV screen even when the browser window is
// phone-sized (≤768 CSS px), instead of the employee mobile app.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./pages/desktop/GreenhouseDisplayPage", () => ({
  GreenhouseDisplayPage: ({ displayKey }: { displayKey: string }) => <div>TV screen for {displayKey}</div>,
}));
vi.mock("./pages/mobile/PairingScreen", () => ({
  PairingScreen: () => <div>Pair this device</div>,
}));

import App, { matchTvDisplayKey } from "./App";

afterEach(() => {
  cleanup();
  window.history.pushState({}, "", "/");
  vi.unstubAllGlobals();
});

describe("TV display route", () => {
  it("recognises only the TV link", () => {
    expect(matchTvDisplayKey("/greenhouse/display/abc_DEF-123")).toBe("abc_DEF-123");
    expect(matchTvDisplayKey("/greenhouse/display/abc/")).toBe("abc");
    expect(matchTvDisplayKey("/greenhouse")).toBeNull();
    expect(matchTvDisplayKey("/display/map")).toBeNull();
    expect(matchTvDisplayKey("/greenhouse/display/a/b")).toBeNull();
  });

  it("renders the TV screen at a phone-sized width instead of the mobile app", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }))
    );
    window.history.pushState({}, "", "/greenhouse/display/narrow-key");
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );
    expect(screen.getByText("TV screen for narrow-key")).toBeInTheDocument();
    expect(screen.queryByText("Pair this device")).not.toBeInTheDocument();
  });
});
