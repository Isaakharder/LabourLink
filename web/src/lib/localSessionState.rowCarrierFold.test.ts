// Regression coverage for a real reported v1.3 offline defect: Marshall
// Dela Cruz, offline, working "Picking Peppers" at Phase 2 / Row 644 / Bin
// 11, changed only the carrier to Bin 14 while still offline. The timer
// kept running and the change queued (2 pending events), but the active
// screen's row/carrier buttons fell back to their placeholder text ("Where?"
// / "Which Carrier?") until the phone reconnected and a real /me response
// arrived — even though the local event genuinely contained the row and
// carrier needed to display the right answer.
//
// Root cause, traced through the actual code path (HomeScreen.tsx's
// confirmSingleQuestionEdit -> currentAnswersFor -> submitQuestionFlow ->
// WorkSessionContext's perform()), not guessed: editing ONE question (e.g.
// carrier) is designed to submit only that question changed, relying on
// currentAnswersFor() to re-include the UNCHANGED row from
// me.currentActivity.row.id. That's exactly the event shape a real
// carrier-only edit produces — greenhouseRowId genuinely absent on THIS
// event, by design, because the row didn't change. The event is complete
// for what it represents (one changed question); the bug is downstream:
// applyLocalEventToMe's work_start/activity_switch case treated an absent
// greenhouseRowId/carrierId as "clear the row/carrier" instead of
// "unspecified — same activity, so preserve whatever was already active."
// That's what a raw server round trip effectively does too (which is why
// reconnecting fixed it) but the local fold didn't replicate it, so an
// offline-only sequence of two quick actions on the same job could
// regress a row that was never actually touched.
//
// Event shapes below are reconstructed from the real local-first commit
// path (see WorkSessionContext.tsx's performInternal + HomeScreen.tsx's
// confirmSingleQuestionEdit/currentAnswersFor), not the literal bytes off
// the phone (not pulled for this investigation) — every id is a synthetic
// placeholder, no employee-identifying data is used anywhere in this file.
import { describe, expect, it, vi } from "vitest";

const { getLocalEventStoreMock } = vi.hoisted(() => ({
  getLocalEventStoreMock: vi.fn(),
}));

vi.mock("./localEventStore", () => ({
  getLocalEventStore: getLocalEventStoreMock,
}));

import { applyLocalEventToMe, foldPendingEventsOntoMe, LocalDisplayInfo } from "./localSessionState";
import { LocalEvent } from "./localEventStore";
import { MeResponse } from "../context/WorkSessionContext";

const EMPLOYEE_ID = "redacted-employee-id";
const DEVICE_ID = "redacted-device-id";
const ACTIVITY_ID = "activity-picking-peppers";
const ROW_644_ID = "row-644";
const BIN_11_ID = "carrier-bin-11";
const BIN_14_ID = "carrier-bin-14";

function baseEvent(overrides: Partial<LocalEvent>): LocalEvent {
  return {
    clientEventId: "evt",
    deviceId: DEVICE_ID,
    employeeId: EMPLOYEE_ID,
    deviceSeq: 1,
    eventType: "activity_switch",
    occurredAtUtc: "2026-08-27T14:00:00.000Z",
    localTzOffsetMinutes: 0,
    activityId: null,
    greenhouseRowId: null,
    carrierId: null,
    answers: null,
    densitySnapshot: null,
    configRevision: null,
    createdAtLocal: "2026-08-27T14:00:00.000Z",
    syncStatus: "pending",
    syncAttempts: 0,
    lastSyncError: null,
    serverResultJson: null,
    ...overrides,
  };
}

// The two REAL pending events this scenario produces, in order:
//  1) the initial offline selection of Picking Peppers / Row 644 / Bin 11
//     — a complete work_start/activity_switch, both row and carrier
//     answered (the normal ActivityPicker -> RowPickerSheet -> CarrierPickerSheet
//     flow submits the whole answer set at once).
//  2) a carrier-only edit to Bin 14 — HomeScreen's confirmSingleQuestionEdit
//     submits currentAnswersFor(activity) (meant to re-include the
//     unchanged row) merged with the new carrier answer. Deliberately
//     modeled here with greenhouseRowId ABSENT, matching exactly what a
//     carrier-only edit produces when it does not itself carry the row
//     forward (see fixEvent below for the corrected shape).
const initialSelectionEvent = baseEvent({
  clientEventId: "evt-1-initial-selection",
  deviceSeq: 1,
  activityId: ACTIVITY_ID,
  greenhouseRowId: ROW_644_ID,
  carrierId: BIN_11_ID,
  occurredAtUtc: "2026-08-27T14:00:00.000Z",
  createdAtLocal: "2026-08-27T14:00:00.000Z",
});

const carrierOnlyEditEvent = baseEvent({
  clientEventId: "evt-2-carrier-only-edit",
  deviceSeq: 2,
  activityId: ACTIVITY_ID,
  greenhouseRowId: null, // the row did not change — this question was never re-submitted
  carrierId: BIN_14_ID,
  occurredAtUtc: "2026-08-27T14:05:00.000Z",
  createdAtLocal: "2026-08-27T14:05:00.000Z",
});

const display: LocalDisplayInfo = {
  activityName: "Picking Peppers",
  rowLabel: "Phase 2 · Row 644",
  carrierName: "Bin 14",
  minimumDurationMinutes: 0,
};

const idleBase: MeResponse = {
  employee: { id: EMPLOYEE_ID, firstName: "", lastName: "", preferredLanguage: null, securityRole: "Employee" },
  status: "idle",
  currentActivity: null,
  since: null,
  previousActivity: null,
  recentJobs: [],
};

describe("offline row/carrier fold — reproduces the reported v1.3 defect", () => {
  it("determines the queued carrier-only event IS missing greenhouseRowId — that is by design (only the changed question is resubmitted), not itself the bug", () => {
    expect(carrierOnlyEditEvent.greenhouseRowId).toBeNull();
    expect(carrierOnlyEditEvent.carrierId).toBe(BIN_14_ID);
    expect(carrierOnlyEditEvent.activityId).toBe(initialSelectionEvent.activityId); // same ongoing job
  });

  it("FIXED: applyLocalEventToMe preserves the unchanged row across a same-activity carrier-only edit — Row 644 stays 644, Bin 11 -> Bin 14", () => {
    const afterFirst = applyLocalEventToMe(idleBase, initialSelectionEvent, display);
    expect(afterFirst.currentActivity?.row?.id).toBe(ROW_644_ID);
    expect(afterFirst.currentActivity?.carrier?.id).toBe(BIN_11_ID);

    const afterSecond = applyLocalEventToMe(afterFirst, carrierOnlyEditEvent, display);
    // The row the employee never touched must still read correctly —
    // HomeScreen's currentAnswerDisplay reads exactly this field, so this
    // is what stops the "Where?" placeholder from ever appearing for an
    // unchanged row.
    expect(afterSecond.currentActivity?.row?.id).toBe(ROW_644_ID);
    expect(afterSecond.currentActivity?.row?.label).toBe("Phase 2 · Row 644");
    expect(afterSecond.currentActivity?.carrier?.id).toBe(BIN_14_ID);
  });

  it("FIXED: the fold/reconstruction path used by cold-start restore and /me reconciliation preserves the row identically", async () => {
    getLocalEventStoreMock.mockReturnValue({
      getPendingEvents: () => Promise.resolve([initialSelectionEvent, carrierOnlyEditEvent]),
      getCachedJson: () => Promise.resolve(null),
    });

    const folded = await foldPendingEventsOntoMe(DEVICE_ID, idleBase);
    expect(folded.currentActivity?.row?.id).toBe(ROW_644_ID);
    expect(folded.currentActivity?.carrier?.id).toBe(BIN_14_ID);
  });

  it("the symmetric case — a row-only edit (carrier unchanged) — preserves the carrier the same way", () => {
    const afterFirst = applyLocalEventToMe(idleBase, initialSelectionEvent, display);
    const rowOnlyEdit = baseEvent({
      clientEventId: "evt-2b-row-only-edit",
      deviceSeq: 2,
      activityId: ACTIVITY_ID,
      greenhouseRowId: "row-650", // moved to a different row
      carrierId: null, // carrier unchanged — not resubmitted
      occurredAtUtc: "2026-08-27T14:10:00.000Z",
    });
    const afterRowEdit = applyLocalEventToMe(afterFirst, rowOnlyEdit, {
      activityName: "Picking Peppers",
      rowLabel: "Phase 2 · Row 650",
      carrierName: null,
      minimumDurationMinutes: 0,
    });
    expect(afterRowEdit.currentActivity?.row?.id).toBe("row-650");
    expect(afterRowEdit.currentActivity?.carrier?.id).toBe(BIN_11_ID); // preserved, not wiped
  });

  it("a single event that changes BOTH row and carrier together works exactly as before (not an edge case for this fix)", () => {
    const afterFirst = applyLocalEventToMe(idleBase, initialSelectionEvent, display);
    const bothChanged = baseEvent({
      clientEventId: "evt-2c-both-changed",
      deviceSeq: 2,
      activityId: ACTIVITY_ID,
      greenhouseRowId: "row-650",
      carrierId: BIN_14_ID,
      occurredAtUtc: "2026-08-27T14:12:00.000Z",
    });
    const afterBoth = applyLocalEventToMe(afterFirst, bothChanged, {
      activityName: "Picking Peppers",
      rowLabel: "Phase 2 · Row 650",
      carrierName: "Bin 14",
      minimumDurationMinutes: 0,
    });
    expect(afterBoth.currentActivity?.row?.id).toBe("row-650");
    expect(afterBoth.currentActivity?.carrier?.id).toBe(BIN_14_ID);
  });

  it("a genuine switch to a DIFFERENT activity is unaffected — row/carrier reset to whatever the new event specifies, never inherited from the old job", () => {
    const afterFirst = applyLocalEventToMe(idleBase, initialSelectionEvent, display);
    const switchToRowlessActivity = baseEvent({
      clientEventId: "evt-3-different-activity",
      deviceSeq: 3,
      activityId: "activity-with-no-row-or-carrier",
      greenhouseRowId: null,
      carrierId: null,
      occurredAtUtc: "2026-08-27T15:00:00.000Z",
    });
    const afterSwitch = applyLocalEventToMe(afterFirst, switchToRowlessActivity, {
      activityName: "General Cleanup",
      rowLabel: null,
      carrierName: null,
      minimumDurationMinutes: 0,
    });
    expect(afterSwitch.currentActivity?.id).toBe("activity-with-no-row-or-carrier");
    expect(afterSwitch.currentActivity?.row).toBeNull();
    expect(afterSwitch.currentActivity?.carrier).toBeNull();
  });
});
