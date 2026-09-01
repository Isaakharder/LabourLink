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
  // Carrier this segment is attached to, if any (see 019_carriers.sql) —
  // same "changing it produces a new time_entries row" property as
  // greenhouse_row_id above, and for the same reason must also break run
  // contiguity.
  carrier_id: string | null;
  // Frozen density snapshot from when this segment was opened (see
  // 025_activity_density_speed.sql) — always null/null together, and only
  // ever non-null on a work segment. IS part of the contiguity check below:
  // it's derived from activity_id + greenhouse_row_id + the activity's
  // density_source *at the moment the segment opened*, and an admin can edit
  // an activity's density_source between two otherwise-contiguous segments
  // (same activity, same row) — so two segments can share activity_id and
  // greenhouse_row_id yet freeze different density types. Without this
  // check, such a pair would be silently merged into one run carrying only
  // the last segment's density type, corrupting that run's quantity/duration
  // pairing for every consumer (Inputs speed, row-completion candidates,
  // report attribution).
  density_type: "plants" | "stems" | null;
  density_count_per_row: number | null;
  // Set only on a midnight-rollover-created continuation segment (see
  // midnightRollover.ts) — points at the entry it continues, always on the
  // OTHER side of a local-midnight boundary from this segment. Never set on
  // an ordinary segment. Exists so callers that need to treat a visit
  // spanning midnight as ONE visit (row-completion ambiguity/candidate
  // resolution — see rowCompletionCandidates.ts) can detect and walk across
  // that boundary; groupIntoActivityRuns itself doesn't need it; a rollover
  // continuation is already boundary-contiguous with matching activity/row/
  // carrier/densityType, so it merges into the same run as its predecessor
  // for free WHENEVER both segments are in the same `entries` array — this
  // field only matters to a caller (like rowCompletionCandidates.ts) that
  // queries one calendar day at a time and therefore never has both halves
  // in one `entries` array to begin with.
  rollover_of_entry_id: string | null;
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
  // Same "single, unambiguous value" guarantee as greenhouseRowId, for
  // carrier.
  carrierId: string | null;
  // Set once from the run's first segment, same as greenhouseRowId/
  // carrierId — safe because a run is always single-row, so every segment
  // in it shares the same resolved snapshot.
  densityType: "plants" | "stems" | null;
  densityCountPerRow: number | null;
  // Set when this run's first segment is boundary-contiguous with the
  // immediately preceding run — same activity, row, and carrier — but
  // differs ONLY in density_type, i.e. it's genuinely the same physical
  // visit, just frozen under a different type because an activity's
  // density_source was edited while an employee was on break between the
  // two (see mobileTime.ts's break/end resume, which now inherits the
  // interrupted entry's own frozen snapshot specifically to prevent this
  // going forward — this field exists for whatever slips through anyway:
  // historical data recorded before that fix, or a manual entry). Points at
  // the immediately preceding run only (never further back) — a consumer
  // that needs the true visit origin walks this chain itself (see
  // rowCompletionCandidates.ts / inputs.ts's visitRoot helpers), since only
  // it has the full run list and completion state needed to know where to
  // stop.
  splitByDensityChangeFromRunId: string | null;
  // Set from this run's FIRST underlying segment's rollover_of_entry_id
  // (segmentIds[0] — see RunSegment's own comment) when that segment is a
  // midnight-rollover continuation. A caller that queries one calendar day
  // at a time (rowCompletionCandidates.ts, inputs.ts) uses this to resolve
  // the run's true visit origin across the midnight boundary, the same way
  // splitByDensityChangeFromRunId already lets it walk across a same-day
  // density-type split.
  rolloverContinuationFromEntryId: string | null;
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
    const sameRowActivityCarrier: boolean =
      current !== null &&
      lastEndedAt !== null &&
      e.started_at.getTime() === lastEndedAt &&
      e.activity_id === current.activityId &&
      e.greenhouse_row_id === current.greenhouseRowId &&
      e.carrier_id === current.carrierId;
    const contiguous = sameRowActivityCarrier && e.density_type === current!.densityType;

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
        carrierId: e.carrier_id,
        densityType: e.density_type,
        densityCountPerRow: e.density_count_per_row,
        splitByDensityChangeFromRunId: sameRowActivityCarrier ? current!.id : null,
        rolloverContinuationFromEntryId: e.rollover_of_entry_id,
      };
      runs.push(current);
    }

    lastEndedAt = e.ended_at ? e.ended_at.getTime() : null;
  }

  return { runs, breaks };
}
