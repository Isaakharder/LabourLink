// Unit coverage for the pure sequence-floor/collision-decision logic behind
// the fix for the Nattawat N "UNIQUE constraint failed: pending_events.
// device_id, pending_events.device_seq" incident — see
// localSequenceAssignment.ts's own header for the full root-cause writeup.
// These are deliberately pure-data tests (no SQLite, no Capacitor) so the
// actual allocation ALGORITHM is exercised directly and fast; the
// integration behavior (mutex serialization, bounded retry against a real
// insert, idempotent-return end to end) is covered separately in
// localEventStore.test.ts.
import { describe, expect, it } from "vitest";
import { computeSequenceFloor, resolveSequenceConflict, SequenceFloorInputs } from "./localSequenceAssignment";

function inputs(overrides: Partial<SequenceFloorInputs> = {}): SequenceFloorInputs {
  return {
    persistedCounterNextSeq: null,
    highestPendingSeq: null,
    highestAcknowledgedSeq: null,
    serverLastProcessedSeq: null,
    ...overrides,
  };
}

describe("computeSequenceFloor", () => {
  it("starts a brand-new device identity at 1 when every source is empty", () => {
    expect(computeSequenceFloor(inputs())).toBe(1);
  });

  it("follows the persisted counter when it's the only/highest source (the normal case)", () => {
    expect(computeSequenceFloor(inputs({ persistedCounterNextSeq: 21 }))).toBe(21);
  });

  // The actual incident: device_seq_counter said next=21, but a row already
  // existed in local pending_events at seq 21 (and by extension 20) —
  // counter drift below what's really been used locally. The floor must
  // come from the higher of the two, not the (stale) counter alone.
  it("counter drift: floors above an existing pending_events row even when the counter itself is stale/low", () => {
    expect(
      computeSequenceFloor(
        inputs({
          persistedCounterNextSeq: 5, // stale — drifted below reality
          highestPendingSeq: 21,
        })
      )
    ).toBe(22);
  });

  it("floors above the highest locally acknowledged (synced) seq even if pending_events was pruned down to nothing", () => {
    expect(
      computeSequenceFloor(
        inputs({
          persistedCounterNextSeq: 5,
          highestPendingSeq: null, // pruned away after syncing
          highestAcknowledgedSeq: 20,
        })
      )
    ).toBe(21);
  });

  // Local event log was reset (reinstall / corrupted-file recovery) while
  // the server still holds a higher watermark from before the reset — the
  // server floor is what stops the freshly-reset device from reusing
  // numbers the server has already consumed and would reject as stale.
  it("server sequence reconciliation: floors above the server's last_processed_seq after a local reset", () => {
    expect(
      computeSequenceFloor(
        inputs({
          persistedCounterNextSeq: null, // fresh local state, nothing recorded
          highestPendingSeq: null,
          highestAcknowledgedSeq: null,
          serverLastProcessedSeq: 20,
        })
      )
    ).toBe(21);
  });

  it("uses the highest of all four sources when they disagree", () => {
    expect(
      computeSequenceFloor(
        inputs({
          persistedCounterNextSeq: 3,
          highestPendingSeq: 7,
          highestAcknowledgedSeq: 5,
          serverLastProcessedSeq: 12,
        })
      )
    ).toBe(13);
  });
});

describe("resolveSequenceConflict", () => {
  it("same clientEventId on the conflicting row: idempotent retry, returns the existing seq (never a second insert)", () => {
    const decision = resolveSequenceConflict(
      "tap-abc",
      { deviceSeq: 21, existingClientEventId: "tap-abc" },
      inputs({ persistedCounterNextSeq: 21 })
    );
    expect(decision).toEqual({ kind: "idempotent", deviceSeq: 21 });
  });

  it("different event on the conflicting row: recalculates the floor above it and returns exactly one retry value", () => {
    const decision = resolveSequenceConflict(
      "tap-new",
      { deviceSeq: 21, existingClientEventId: "some-other-tap" },
      inputs({ persistedCounterNextSeq: 21, highestPendingSeq: 21 })
    );
    expect(decision).toEqual({ kind: "retry", deviceSeq: 22 });
  });

  it("folds the conflicting seq into the floor even if the prior read hadn't seen it yet (a genuinely concurrent writer)", () => {
    const decision = resolveSequenceConflict(
      "tap-new",
      { deviceSeq: 30, existingClientEventId: "some-other-tap" },
      // Our own read only knew about seq 21 — the conflict just proved 30 is
      // also taken, by someone else, between our read and our insert.
      inputs({ persistedCounterNextSeq: 21, highestPendingSeq: 21 })
    );
    expect(decision).toEqual({ kind: "retry", deviceSeq: 31 });
  });
});
