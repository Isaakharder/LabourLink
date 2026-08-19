import { describe, expect, it } from "vitest";
import { computeSyncIndicatorState } from "./syncIndicator";

describe("computeSyncIndicatorState", () => {
  it("is 'synced' when online, nothing pending, and sync is healthy", () => {
    expect(computeSyncIndicatorState({ online: true, pending: 0, syncProblem: false })).toBe("synced");
  });

  it("is 'pending' when online with unsynced events and sync is healthy", () => {
    expect(computeSyncIndicatorState({ online: true, pending: 3, syncProblem: false })).toBe("pending");
  });

  it("is 'offline' when offline, regardless of pending count", () => {
    expect(computeSyncIndicatorState({ online: false, pending: 0, syncProblem: false })).toBe("offline");
    expect(computeSyncIndicatorState({ online: false, pending: 5, syncProblem: false })).toBe("offline");
  });

  it("is 'problem' whenever syncProblem is true, even while online with nothing pending", () => {
    // A device can still be flagged 'problem' immediately after its last
    // failure clears the queue via a different path (e.g. a conflict) —
    // syncProblem is sticky until the next successful sync, not derived
    // from pending count.
    expect(computeSyncIndicatorState({ online: true, pending: 0, syncProblem: true })).toBe("problem");
  });

  it("prioritizes 'problem' over 'offline' — a device already failing to sync is still a problem once reconnected", () => {
    expect(computeSyncIndicatorState({ online: false, pending: 2, syncProblem: true })).toBe("problem");
  });
});
