// Partitions a day's time_entries (for one employee, ascending by
// started_at) into logical activity runs: a work entry extends the
// in-progress run only if it's contiguous with whatever came immediately
// before it (its started_at exactly equals the previous entry's ended_at —
// the same bit-identical-boundary property server/src/routes/mobileTime.ts
// already relies on, since openEntry() there closes the prior row and
// inserts the next one inside a single transaction, and Postgres resolves
// every now() call within one transaction to the same value) AND shares the
// same activity_id. A break in between is transparent — it doesn't end the
// run, but does still have to be the thing the next work entry is
// contiguous *with*. This file reimplements that same contiguity principle
// independently for whole-day partitioning; mobileTime.ts itself is
// intentionally left untouched.

export interface RunSegment {
  id: string;
  entry_type: "work" | "break";
  activity_id: string | null;
  started_at: Date;
  ended_at: Date | null;
  // Greenhouse row this segment is attached to, if any (see
  // 015_time_entries_greenhouse_row.sql). A row change produces a new
  // time_entries row the same way an activity change does (see openEntry in
  // mobileTime.ts), so it must also break run contiguity below — otherwise
  // two segments on different rows would get silently merged into one
  // displayed run.
  greenhouse_row_id: string | null;
}

export interface ActivityRun {
  id: string; // the run's last (or only) underlying time_entries.id — what a correction PATCH targets
  activityId: string;
  startedAt: Date; // first segment's started_at
  currentSegmentStartedAt: Date; // last (possibly only) segment's started_at — the basis for a live timer when isOpen
  endedAt: Date | null;
  durationSeconds: number; // work segments only, breaks excluded, current open segment's own elapsed time not included
  isOpen: boolean;
  segmentIds: string[];
  // Single, unambiguous value for the whole run — the contiguity check
  // below guarantees a run can never internally span two different rows.
  greenhouseRowId: string | null;
}

export interface BreakSegment {
  id: string;
  startedAt: Date;
  endedAt: Date | null;
}

export function groupIntoActivityRuns(entries: RunSegment[]): {
  runs: ActivityRun[];
  breaks: BreakSegment[];
} {
  const runs: ActivityRun[] = [];
  const breaks: BreakSegment[] = [];
  let current: ActivityRun | null = null;
  let lastEndedAt: number | null = null; // ended_at of the immediately preceding entry, of either type

  for (const e of entries) {
    if (e.entry_type === "break") {
      breaks.push({ id: e.id, startedAt: e.started_at, endedAt: e.ended_at });
      lastEndedAt = e.ended_at ? e.ended_at.getTime() : null;
      continue;
    }

    const segDuration = e.ended_at ? (e.ended_at.getTime() - e.started_at.getTime()) / 1000 : 0;
    const contiguous =
      current !== null &&
      lastEndedAt !== null &&
      e.started_at.getTime() === lastEndedAt &&
      e.activity_id === current.activityId &&
      e.greenhouse_row_id === current.greenhouseRowId;

    if (contiguous && current) {
      current.id = e.id;
      current.currentSegmentStartedAt = e.started_at;
      current.endedAt = e.ended_at;
      current.isOpen = e.ended_at === null;
      current.durationSeconds += segDuration;
      current.segmentIds.push(e.id);
    } else {
      current = {
        id: e.id,
        activityId: e.activity_id!,
        startedAt: e.started_at,
        currentSegmentStartedAt: e.started_at,
        endedAt: e.ended_at,
        durationSeconds: segDuration,
        isOpen: e.ended_at === null,
        segmentIds: [e.id],
        greenhouseRowId: e.greenhouse_row_id,
      };
      runs.push(current);
    }

    lastEndedAt = e.ended_at ? e.ended_at.getTime() : null;
  }

  return { runs, breaks };
}
