// @vitest-environment jsdom
//
// Direct unit tests for the error-boundary mechanism itself (a deliberately
// throwing child, not a naturally-occurring data shape — those are covered
// end-to-end in InputsPage.switching.test.tsx, where the actual real-world
// malformed field now degrades gracefully before ever reaching this
// boundary at all). This proves the BACKSTOP: something neither the server
// fix nor the client's own defensive formatters anticipated still isolates
// to just the affected section/row, never blanks anything else, carries a
// diagnostic id, and recovers the moment resetKey changes.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InputsErrorBoundary } from "./InputsErrorBoundary";

function Boom(): never {
  throw new Error("synthetic render failure");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("InputsErrorBoundary", () => {
  it("renders children normally when nothing throws", () => {
    render(
      <InputsErrorBoundary resetKey="a" label="test section">
        <p>All good</p>
      </InputsErrorBoundary>
    );
    expect(screen.getByText("All good")).toBeInTheDocument();
  });

  it("catches a render error, shows the default 'Needs review' fallback with a diagnostic id, and logs the label + id", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <InputsErrorBoundary resetKey="a" label="test section">
        <Boom />
      </InputsErrorBoundary>
    );
    expect(screen.getByText("Needs review")).toBeInTheDocument();
    expect(screen.getByText(/Reference:/)).toBeInTheDocument();
    const logged = consoleSpy.mock.calls.some(
      (args) => typeof args[0] === "string" && args[0].includes("test section") && args[0].includes("ref ")
    );
    expect(logged).toBe(true);
  });

  it("uses a custom fallback (e.g. a <tr>/<td> shape) when provided", () => {
    const { container } = render(
      <table>
        <tbody>
          <InputsErrorBoundary
            resetKey="a"
            label="row"
            renderFallback={(diagnosticId) => (
              <tr>
                <td>Row needs review — {diagnosticId}</td>
              </tr>
            )}
          >
            <Boom />
          </InputsErrorBoundary>
        </tbody>
      </table>
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(container.querySelector("td")?.textContent).toMatch(/Row needs review — [A-Z0-9]+/);
  });

  it("isolates one failing boundary from a sibling — the sibling renders fine", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <>
        <InputsErrorBoundary resetKey="a" label="broken section">
          <Boom />
        </InputsErrorBoundary>
        <InputsErrorBoundary resetKey="b" label="healthy section">
          <p>Still here</p>
        </InputsErrorBoundary>
      </>
    );
    expect(screen.getByText("Needs review")).toBeInTheDocument();
    expect(screen.getByText("Still here")).toBeInTheDocument();
  });

  it("recovers the moment resetKey changes, without needing a full app reload", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <InputsErrorBoundary resetKey="2026-08-31" label="daily detail">
        <Boom />
      </InputsErrorBoundary>
    );
    expect(screen.getByText("Needs review")).toBeInTheDocument();

    // Navigating to a different date (a new resetKey) with healthy content
    // this time — the boundary must let it through, not stay wedged.
    rerender(
      <InputsErrorBoundary resetKey="2026-09-01" label="daily detail">
        <p>September 1st data</p>
      </InputsErrorBoundary>
    );
    expect(screen.getByText("September 1st data")).toBeInTheDocument();
    expect(screen.queryByText("Needs review")).not.toBeInTheDocument();
  });

  it("gives each failure its own diagnostic id", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <InputsErrorBoundary resetKey="1" label="test section">
        <Boom />
      </InputsErrorBoundary>
    );
    const firstRef = screen.getByText(/Reference:/).textContent;

    rerender(
      <InputsErrorBoundary resetKey="2" label="test section">
        <Boom />
      </InputsErrorBoundary>
    );
    const secondRef = screen.getByText(/Reference:/).textContent;
    expect(secondRef).not.toBe(firstRef);
  });
});
