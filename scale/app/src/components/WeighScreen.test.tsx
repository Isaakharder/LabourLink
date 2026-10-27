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

  it("shows awaiting assignment, not a name, for a pending weighing", () => {
    const w = makeWeighing({ assignmentStatus: "pending", employeeName: null, pendingUntil: "2026-10-28T10:00:00.000Z" });
    render(<WeighScreen s={makeSnapshot({ phase: { phase: "awaitingRemoval", reason: "recorded", bin: BIN, emptySinceMs: null }, currentWeighing: w, recent: [w] })} />);
    expect(screen.getByText("Awaiting employee assignment")).toBeInTheDocument();
    expect(screen.queryByText("Picker Alpha")).not.toBeInTheDocument();
  });
});
