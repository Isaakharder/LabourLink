// @vitest-environment jsdom
//
// Hardware-test mode: the real scale and reader show their own connection
// state, the LabourLink link stays the in-process test server, a banner says
// the weighings are test data, and indicator data the station can't parse is
// named as such rather than shown as a silent scale.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { TopBar } from "./components/TopBar";
import { RegisterBins } from "./components/RegisterBins";
import { headline } from "./format";
import { makeSnapshot } from "./testFixtures";
import type { Snapshot } from "./types";

let current: Snapshot | null = null;

vi.mock("./api", () => ({
  useSnapshot: () => ({ snapshot: current, connected: true }),
  call: vi.fn(() => Promise.reject(new Error("not used"))),
  ServiceError: class extends Error {},
}));

afterEach(() => {
  cleanup();
  current = null;
});

function hardwareTest(over: Partial<Snapshot> = {}): Snapshot {
  return makeSnapshot({
    mode: "hardware-test",
    simulated: false,
    connections: {
      scale: { state: "connected", detail: "/dev/serial/by-id/usb-FTDI_FT232R_USB_UART_BG0427FU-if00-port0 @ 9600" },
      rfid: { state: "connected", detail: "/dev/labourlink/rfid @ 9600" },
      server: { state: "simulated", detail: "Hardware test: in-process test server, no network. Nothing is sent to LabourLink" },
      serverLastOkAt: null,
    },
    ...over,
  });
}

function pill(label: string): HTMLElement {
  return screen.getByText(label, { selector: ".pill-label" }).closest(".pill") as HTMLElement;
}

describe("hardware-test mode", () => {
  it("shows the real scale and reader as connected and LabourLink as simulated, under a test-data banner", () => {
    current = hardwareTest();
    render(<App />);
    expect(screen.getByText(/^HARDWARE TEST MODE: real scale and RFID reader, test bins only.*never sent to LabourLink/)).toHaveClass("sim-banner");
    expect(screen.queryByText(/SIMULATION MODE/)).toBeNull();
    expect(within(pill("Scale")).getByText("Connected")).toBeInTheDocument();
    expect(within(pill("RFID")).getByText("Connected")).toBeInTheDocument();
    expect(within(pill("LabourLink")).getByText("Simulated")).toBeInTheDocument();
    // No simulator drawer: hardware comes from the real ports.
    expect(screen.queryByRole("complementary", { name: "Simulation controls" })).toBeNull();
    expect(document.querySelector(".app")).toHaveClass("is-sim");
  });

  it("names indicator data the station can't parse instead of a silent scale", () => {
    const s = hardwareTest({ scaleOnline: false });
    s.connections.scale = { state: "unrecognized", detail: "… 12 frames not recognised, last: <STX>   93.0X<ETX>" };
    expect(headline(s).title).toBe("Scale data not recognised");
    render(<TopBar snapshot={s} serviceConnected view="weigh" onToggleView={() => {}} />);
    expect(within(pill("Scale")).getByText("Data not recognised")).toBeInTheDocument();
    expect(pill("Scale")).toHaveClass("pill-bad");
    expect(pill("Scale")).toHaveAttribute("title", expect.stringContaining("<STX>   93.0X<ETX>"));
  });

  it("still reports a port that is open but silent as not responding", () => {
    const s = hardwareTest({ scaleOnline: false });
    expect(headline(s).title).toBe("Scale not responding");
    render(<TopBar snapshot={s} serviceConnected view="weigh" onToggleView={() => {}} />);
    expect(within(pill("Scale")).getByText("Offline")).toBeInTheDocument();
  });

  it("explains that Register Bins goes to the test bins", () => {
    render(<RegisterBins s={hardwareTest()} onDone={() => {}} />);
    expect(screen.getByText(/Hardware test: sign in to the test server with picker@sim.local/)).toBeInTheDocument();
    expect(screen.queryByText(/Simulation:/)).toBeNull();
  });

  it("shows the trial banner when the station's credits are off, and nothing when they are on", () => {
    current = makeSnapshot({ creditsEnabled: false });
    render(<App />);
    expect(screen.getByText(/TRIAL: credits are off for this station/)).toBeInTheDocument();
    cleanup();
    current = makeSnapshot({ creditsEnabled: true });
    render(<App />);
    expect(screen.queryByText(/TRIAL: credits are off/)).toBeNull();
  });

  it("keeps weighing paused and offers to close Register Bins when it was left open", () => {
    current = makeSnapshot({
      registration: { person: "Pia Picker", phase: { phase: "ready" }, reading: null, scaleOnline: true, settleRemainingMs: 0, clearRemainingMs: 0 },
    });
    render(<App />);
    expect(screen.getByText(/Opened by Pia Picker. Weighing is paused/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close Register Bins and resume weighing" })).toBeInTheDocument();
  });
});
