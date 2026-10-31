// @vitest-environment jsdom
//
// Carriers > Edit: the tag and tare history (CarrierHistory.tsx) names who
// changed what, where, and when — registrations at the weighing station and
// Carriers page edits alike. lib/api.ts is mocked.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CarrierHistory } from "./CarrierHistory";
import { CarrierHistoryEntry } from "../../lib/carrierTypes";

let history: CarrierHistoryEntry[] = [];

vi.mock("../../lib/api", () => ({
  ApiError: class extends Error {},
  api: vi.fn(() => Promise.resolve({ history })),
}));

afterEach(cleanup);

const base: Omit<CarrierHistoryEntry, "id" | "action" | "source"> = {
  oldRfidTag: null,
  newRfidTag: null,
  oldTareWeightKg: null,
  newTareWeightKg: null,
  measuredGrossKg: null,
  overwriteConfirmed: null,
  reason: null,
  performedAt: "2026-10-31T14:05:00Z",
  performedBy: "Pia Picker",
  stationName: null,
  movedToName: null,
  movedFromName: null,
};

describe("CarrierHistory", () => {
  it("describes station registrations, moves and page edits with who and where", async () => {
    history = [
      { ...base, id: "3", source: "carriers_page", action: "page_edit", oldTareWeightKg: 154.4, newTareWeightKg: 155, newRfidTag: "0000000182225750", oldRfidTag: "0000000182225750", performedBy: "Adam Admin" },
      {
        ...base,
        id: "2",
        source: "scale_station",
        action: "register",
        oldRfidTag: "0000000182225750",
        newRfidTag: "0000000182225750",
        oldTareWeightKg: 150,
        newTareWeightKg: 154.4,
        overwriteConfirmed: true,
        stationName: "Weigh station 1",
      },
      { ...base, id: "1", source: "scale_station", action: "move_tag", oldRfidTag: "0000000182225750", newRfidTag: null, oldTareWeightKg: 160.2, newTareWeightKg: 150, movedToName: "Bin 4", stationName: "Weigh station 1", reason: "Tag moved to Bin 4" },
    ];
    render(<CarrierHistory carrierId="c-1" />);
    expect(await screen.findByText("Edited: tare 154.40 kg → 155.00 kg")).toBeInTheDocument();
    expect(screen.getByText(/· Adam Admin on the Carriers page/)).toBeInTheDocument();
    expect(screen.getByText("Registered at the scale: tare 150.00 kg → 154.40 kg (replacement confirmed)")).toBeInTheDocument();
    expect(screen.getAllByText(/· Pia Picker at Weigh station 1/)).toHaveLength(2);
    expect(screen.getByText("Tag moved to Bin 4: tag 0000000182225750 → none, tare 160.20 kg → 150.00 kg")).toBeInTheDocument();
  });

  it("says so when nothing has been recorded", async () => {
    history = [];
    render(<CarrierHistory carrierId="c-1" />);
    expect(await screen.findByText("No tag or tare changes recorded yet.")).toBeInTheDocument();
  });
});
