import type { Snapshot, Weighing } from "./types";

export const BIN = { carrierId: "sim-carrier-01", carrierName: "Sim Bin 1", tag: "0000000182225750", tareG: 27_500 };

export function makeWeighing(over: Partial<Weighing> = {}): Weighing {
  return {
    id: "w-1",
    carrierId: BIN.carrierId,
    carrierName: BIN.carrierName,
    rfidTag: BIN.tag,
    grossG: 64_380,
    tareG: 27_500,
    netG: 36_880,
    recordedAt: "2026-10-27T10:00:00.000Z",
    simulated: true,
    uploadState: "sent",
    uploadAttempts: 1,
    lastError: null,
    assignmentStatus: "credited",
    employeeName: "Picker Alpha",
    pendingUntil: null,
    ...over,
  };
}

export function makeSnapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    mode: "simulation",
    simulated: true,
    stationName: "Packhouse scale",
    phase: { phase: "idle" },
    settleRemainingMs: 0,
    removalRemainingMs: 0,
    scaleOnline: true,
    reading: { weightG: 0, mode: "gross", motion: false, overload: false, underload: false, error: false },
    bin: null,
    liveNetG: null,
    currentWeighing: null,
    recent: [],
    lastTag: null,
    connections: {
      scale: { state: "simulated", detail: "" },
      rfid: { state: "simulated", detail: "" },
      server: { state: "simulated", detail: "" },
      serverLastOkAt: null,
    },
    outbox: { queued: 0, pending: 0, attention: 0 },
    carrierCount: 15,
    params: { settleMs: 10_000, removalMs: 2_000, minLoadG: 2_000, duplicateGuardMs: 300_000 },
    rig: null,
    ...over,
  };
}
