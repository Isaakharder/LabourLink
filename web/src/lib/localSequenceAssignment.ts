// Pure decision logic for allocating a local device_seq — split out of
// localEventStore.ts's appendEvent() so the actual bug class behind the
// 2026-09-14 Nattawat N incident (a phone that had already synced through
// device_seq 20 computed device_seq 21 for its next local commit, but a row
// already existed at 21 in this device's own local pending_events table —
// `UNIQUE constraint failed: pending_events.device_id, pending_events.
// device_seq (code 2067)`, repeating on every retry because retrying
// recomputed the identical doomed value) is covered by fast, deterministic
// unit tests instead of only being reachable through the real native SQLite
// plugin (not available under Vitest/jsdom).
//
// Root cause, as far as it can be pinned down without a debug build: the
// previous implementation trusted device_seq_counter.next_seq as the ONLY
// source of truth for "what's next," computed inside a SQLite transaction
// that's atomic against ITSELF but not against a second, overlapping call to
// appendEvent() — nothing serialized concurrent callers before this fix
// (see localEventStore.ts's new appendMutex). The captured logcat shows the
// device's ColdStartWatchdog recreating MainActivity multiple times during a
// slow cold start (attempts #0-#3, 5s/7s/9s/11s) — a very plausible trigger
// for two overlapping attempts to commit the same still-pending local event
// (a fresh Activity/WebView re-driving a commit while an earlier one from
// the just-destroyed context hadn't actually finished settling), each
// reading next_seq before the other's write landed, so both tried to insert
// at the same device_seq. Whichever committed first "won" the seq; every
// subsequent retry (by the surviving, now-permanently-stuck event) kept
// recomputing that same already-taken number forever, which is exactly why
// a restart didn't clear it — device_seq_counter and pending_events are
// both in the same on-disk labourlink_eventsSQLite.db, untouched by an app
// restart. This fix closes the gap two ways: appendMutex removes the
// concurrent-caller race for the common (single-process) case, and
// resolveNextDeviceSeq's floor is defensive even against a stale/corrupted
// counter alone, by never trusting device_seq_counter as the sole source.
export interface SequenceFloorInputs {
  // device_seq_counter.next_seq for this device_id — null if no row exists
  // yet (brand-new device identity, e.g. after re-pairing).
  persistedCounterNextSeq: number | null;
  // max(device_seq) across every row currently in local pending_events for
  // this device_id, regardless of sync_status — null if the table has no
  // rows for this device at all. Never a full row dump: only the max is
  // needed to compute a floor.
  highestPendingSeq: number | null;
  // max(device_seq) among this device's LOCALLY synced/acknowledged rows —
  // deliberately tracked separately from highestPendingSeq so a caller that
  // prunes synced rows out of pending_events (pruneSyncedOlderThan) can't
  // silently lower the floor by deleting the very rows that proved a seq
  // was already used.
  highestAcknowledgedSeq: number | null;
  // Best-effort, persisted locally from the server's own device_sync_state.
  // last_processed_seq the last time a sync response actually returned one
  // (see syncEngine.ts) — null if this device has never synced, or the
  // server hasn't reported one yet. Included specifically to survive a
  // scenario none of the other three sources can: the local event log was
  // reset (reinstall, corrupted-file recovery) while the server still holds
  // a higher watermark — without this, a freshly-reset device would happily
  // reuse device_seq numbers the server has already consumed and would
  // reject as stale/duplicate on the next sync.
  serverLastProcessedSeq: number | null;
}

// The four inputs, normalized to "highest USED seq" (not "next available"),
// then the allocated seq is simply one past the highest of all of them —
// "use the highest known value plus one," applied uniformly instead of
// trusting any single source.
export function computeSequenceFloor(inputs: SequenceFloorInputs): number {
  const highestUsed = Math.max(
    // persistedCounterNextSeq is a NEXT value, not a highest-used one —
    // convert it (next=1 with nothing used yet still floors at 0 here).
    (inputs.persistedCounterNextSeq ?? 1) - 1,
    inputs.highestPendingSeq ?? 0,
    inputs.highestAcknowledgedSeq ?? 0,
    inputs.serverLastProcessedSeq ?? 0
  );
  return highestUsed + 1;
}

export interface ConflictInfo {
  // The device_seq that the just-attempted INSERT collided on.
  deviceSeq: number;
  // The client_event_id already occupying that device_seq, read back from
  // pending_events after the collision.
  existingClientEventId: string;
}

export type SequenceAssignmentDecision =
  // Same clientEventId already occupies the seq we tried — this is a retry
  // of a physical tap whose local write already landed (e.g. a caller-level
  // timeout raced an insert that actually succeeded a moment later, or the
  // UI retried before the JS event loop confirmed the first attempt). Never
  // insert a second row for the same clientEventId; return the existing one
  // as-is (idempotent).
  | { kind: "idempotent"; deviceSeq: number }
  // A DIFFERENT event already holds that seq — recalculate the floor
  // treating the just-discovered conflict as additional, authoritative
  // evidence of what's actually used, and retry exactly once with the new
  // value. Never looped further than this by the caller (see
  // localEventStore.ts's MAX_SEQUENCE_ALLOCATION_ATTEMPTS).
  | { kind: "retry"; deviceSeq: number };

// Called only after a real UNIQUE(device_id, device_seq) collision — decides
// idempotent-return vs. recompute-and-retry-once from the conflicting row's
// own client_event_id, per this fix's explicit requirement to inspect the
// conflicting row rather than blindly incrementing.
export function resolveSequenceConflict(
  clientEventId: string,
  conflict: ConflictInfo,
  priorFloorInputs: SequenceFloorInputs
): SequenceAssignmentDecision {
  if (conflict.existingClientEventId === clientEventId) {
    return { kind: "idempotent", deviceSeq: conflict.deviceSeq };
  }
  const floor = computeSequenceFloor({
    ...priorFloorInputs,
    // The conflicting row is proof-positive evidence a seq is taken, even
    // if it hadn't shown up in highestPendingSeq's own read (e.g. inserted
    // by a genuinely concurrent writer between our read and our insert) —
    // fold it in explicitly rather than trusting the stale read again.
    highestPendingSeq: Math.max(priorFloorInputs.highestPendingSeq ?? 0, conflict.deviceSeq),
  });
  return { kind: "retry", deviceSeq: floor };
}
