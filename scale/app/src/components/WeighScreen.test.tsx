import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WeighScreen } from "./WeighScreen";
import { BIN, makeSnapshot, makeWeighing } from "../testFixtures";

afterEach(cleanup);

describe("WeighScreen", () => {
  it("shows bin, live gross, carrier tare, live net and the settling countdown", () => {
    render(
      <WeighScreen
        s={makeSnapshot({
          phase: { phase: "settling", bin: BIN, startedMs: 0 },
          settleRemainingMs: 6_200,
          bin: BIN,
          reading: { weightG: 64_120, mode: "gross", motion: true, overload: false, underload: false, error: false },
          liveNetG: 36_620,
        })}
      />
    );
    expect(screen.getByText("Settling…")).toBeInTheDocument();
    expect(screen.getByText("7 s")).toBeInTheDocument();
    expect(screen.getByText("Sim Bin 1")).toBeInTheDocument();
    expect(screen.getByText(/64\.12/)).toBeInTheDocument();
    expect(screen.getByText(/− 27\.50/)).toBeInTheDocument();
    expect(screen.getByTestId("net")).toHaveTextContent("36.62");
    expect(screen.getByText("Motion")).toBeInTheDocument();
    expect(screen.getByText("Verified after weighing")).toBeInTheDocument();
  });

  it("freezes the recorded weighing and shows the credited employee", () => {
    const w = makeWeighing();
    render(
      <WeighScreen
        s={makeSnapshot({
          phase: { phase: "awaitingRemoval", reason: "recorded", bin: BIN, emptySinceMs: null },
          bin: BIN,
          reading: { weightG: 64_500, mode: "gross", motion: false, overload: false, underload: false, error: false },
          liveNetG: 37_000,
          currentWeighing: w,
          recent: [w],
        })}
      />
    );
    expect(screen.getByText("Weight recorded")).toBeInTheDocument();
    expect(screen.getByTestId("net")).toHaveTextContent("36.88");
    expect(screen.getByText("Recorded")).toBeInTheDocument();
    expect(screen.getAllByText("Picker Alpha").length).toBeGreaterThan(0);
  });

  it("shows the WAIT warning prominently and clears it when the scale is ready", () => {
    const waiting = makeSnapshot({
      waitForZero: true,
      phase: { phase: "awaitingRemoval", reason: "recorded", bin: BIN, emptySinceMs: null },
      bin: BIN,
      reading: { weightG: 58_000, mode: "gross", motion: false, overload: false, underload: false, error: false },
      liveNetG: 30_500,
      currentWeighing: makeWeighing(),
    });
    const { rerender } = render(<WeighScreen s={waiting} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("WAIT — Scale must return to zero before next bin.");
    expect(status).toHaveClass("tone-error");
    expect(screen.queryByText("Weight recorded")).not.toBeInTheDocument();
    // The previous bin's frozen values are not shown while the next bin sits on the scale.
    expect(screen.queryByText("Sim Bin 1")).not.toBeInTheDocument();
    expect(screen.getByText(/58\.00/)).toBeInTheDocument();
    expect(screen.getByTestId("net")).not.toHaveTextContent(/\d/);
    rerender(<WeighScreen s={makeSnapshot({ waitForZero: false, phase: { phase: "idle" } })} />);
    expect(screen.queryByText(/WAIT/)).not.toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });

  it("shows awaiting assignment, not a name, for a pending weighing", () => {
    const w = makeWeighing({ assignmentStatus: "pending", employeeName: null, pendingUntil: "2026-10-28T10:00:00.000Z" });
    render(<WeighScreen s={makeSnapshot({ phase: { phase: "awaitingRemoval", reason: "recorded", bin: BIN, emptySinceMs: null }, currentWeighing: w, recent: [w] })} />);
    expect(screen.getByText("Awaiting employee assignment")).toBeInTheDocument();
    expect(screen.queryByText("Picker Alpha")).not.toBeInTheDocument();
  });
});
