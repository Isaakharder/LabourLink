// Bulk speed review (Inputs "Review speeds" / "Review all employees"): every
// visit that shows "Needs review" on Inputs for one date, organized into
// proposed review groups with the actions the existing row-completion rules
// support for each.
//
// Built ONLY from the existing rules — never a second ambiguity or speed
// calculation:
//   - visits and 7-day row-work cycles come from getUnresolvedRunsForRows
//     (rowCompletionCandidates.ts), the same source Inputs' badge, the
//     individual review modal, Reports and Productive TV all use;
//   - a cycle needs review exactly when it has 2+ unresolved visits, the
//     same per-cycle test inputs.ts applies (ambiguousCycleKeys);
//   - only activities that currently have a density source, the same
//     condition the Inputs badge renders under;
//   - speed previews go through aggregateDensitySpeed, the only place a
//     speed is ever divided.
//
// A group is ONE employee's visits on the selected date inside ONE
// ambiguous cycle (same row, activity and frozen density type). Other
// employees' visits, and the same employee's visits on other dates, that
// share the cycle are returned as read-only context: they explain why the
// group needs review but are never part of the group, so applying a group
// can never combine different employees or dates. Different rows are never
// grouped, even when they share a carrier/bin.
//
// Supported actions, both creating ordinary confirmed completions through
// createRowCompletion (rowCompletionCreate.ts):
//   merge     2+ finished visits by this employee to this row on this date,
//             all with the same frozen stems-per-row -> ONE completion: the
//             row's quantity counts once over the visits' combined work time.
//   separate  every visit finished with a single frozen density value -> one
//             completion PER visit, the existing "select one visit on its
//             own" individual rule.
// Anything else stays pending, with the reason returned.
import { pool } from "../db";
import { aggregateDensitySpeed } from "./densitySpeed";
import { CandidateRun, getUnresolvedRunsForRows } from "./rowCompletionCandidates";
import { getDayBoundsUtc } from "./timezone";

export type SpeedReviewAction = "merge" | "separate";

export interface SpeedReviewVisit {
  visitId: string;
  segmentIds: string[];
  employeeId: string;
  employeeName: string;
  date: string;
  startedAt: string;
  endedAt: string | null;
  // Work time only: breaks are separate entries and never part of a
  // visit's duration (see activityRuns.ts / rowCompletionCandidates.ts).
  durationSeconds: number;
  isOpen: boolean;
  carriers: string[];
  // The visit's single frozen stems/plants-per-row, or null when its
  // segments disagree (density setting changed mid-visit).
  quantityPerRow: number | null;
}

export interface SpeedPreview {
  quantity: number;
  durationSeconds: number;
  speedPerHour: number | null;
}

export interface SpeedReviewGroup {
  id: string;
  employeeId: string;
  employeeName: string;
  date: string;
  activityId: string;
  activityName: string;
  greenhouseRowId: string;
  rowLabel: string;
  densityType: "plants" | "stems";
  unit: string;
  reasons: string[];
  visits: SpeedReviewVisit[];
  contextVisits: SpeedReviewVisit[];
  actions: {
    merge: { available: boolean; unavailableReason: string | null; preview: SpeedPreview | null };
    separate: {
      available: boolean;
      unavailableReason: string | null;
      previews: (SpeedPreview & { visitId: string })[] | null;
    };
  };
  suggestedAction: SpeedReviewAction | null;
}

interface SegmentRow {
  id: string;
  started_at: Date;
  ended_at: Date | null;
  density_type: "plants" | "stems" | null;
  density_count_per_row: number | null;
  carrier_name: string | null;
}

function formatShortDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export async function getSpeedReviewGroups(opts: { date: string; employeeId?: string | null }): Promise<SpeedReviewGroup[]> {
  const { start: dayStart, end: dayEnd } = getDayBoundsUtc(opts.date);
  const employeeId = opts.employeeId ?? null;

  // Every row+activity+density this date's unresolved work touched — the
  // same pairs Inputs checks for its badge, limited to activities that
  // currently have a density source (the badge's own render condition).
  const { rows: pairRows } = await pool.query(
    `select distinct te.greenhouse_row_id, te.activity_id, te.density_type
     from time_entries te
     join activities a on a.id = te.activity_id
     left join row_completion_segments rcs on rcs.time_entry_id = te.id
     where te.entry_type = 'work' and te.deleted_at is null
       and te.greenhouse_row_id is not null and te.density_type is not null and te.density_count_per_row is not null
       and a.density_source is not null
       and rcs.time_entry_id is null
       and te.started_at >= $1 and te.started_at < $2
       and ($3::uuid is null or te.employee_id = $3)`,
    [dayStart, dayEnd, employeeId]
  );
  if (pairRows.length === 0) return [];

  const candidatesByKey = await getUnresolvedRunsForRows(
    pairRows.map((p) => ({ greenhouseRowId: p.greenhouse_row_id, activityId: p.activity_id, densityType: p.density_type }))
  );

  // Ambiguous cycles only — exactly inputs.ts's ambiguousCycleKeys test.
  const ambiguousCycles: { key: string; densityType: "plants" | "stems"; candidates: CandidateRun[] }[] = [];
  for (const [key, list] of candidatesByKey) {
    const byCycle = new Map<number, CandidateRun[]>();
    for (const c of list) byCycle.set(c.cycleIndex, [...(byCycle.get(c.cycleIndex) ?? []), c]);
    const densityType = key.slice(key.lastIndexOf(":") + 1) as "plants" | "stems";
    for (const cycleCandidates of byCycle.values()) {
      if (cycleCandidates.length > 1) ambiguousCycles.push({ key, densityType, candidates: cycleCandidates });
    }
  }
  if (ambiguousCycles.length === 0) return [];

  const allSegmentIds = [...new Set(ambiguousCycles.flatMap((c) => c.candidates.flatMap((r) => r.segmentIds)))];
  const { rows: segRows } = await pool.query<SegmentRow>(
    `select te.id, te.started_at, te.ended_at, te.density_type, te.density_count_per_row, c.name as carrier_name
     from time_entries te
     left join carriers c on c.id = te.carrier_id
     where te.id = any($1::uuid[])`,
    [allSegmentIds]
  );
  const segById = new Map(segRows.map((s) => [s.id, s]));

  function toVisit(c: CandidateRun, densityType: "plants" | "stems"): SpeedReviewVisit {
    const segs = c.segmentIds.map((id) => segById.get(id)).filter((s): s is SegmentRow => s !== undefined);
    const counts = new Set(segs.map((s) => (s.density_type === densityType && s.density_count_per_row != null ? Number(s.density_count_per_row) : NaN)));
    const [only] = counts;
    const quantityPerRow = counts.size === 1 && !Number.isNaN(only) && segs.length === c.segmentIds.length ? only : null;
    return {
      visitId: c.runId,
      segmentIds: c.segmentIds,
      employeeId: c.employeeId,
      employeeName: c.employeeName,
      date: c.date,
      startedAt: c.startedAt,
      endedAt: c.endedAt,
      durationSeconds: c.durationSeconds,
      isOpen: c.endedAt === null || segs.some((s) => s.ended_at === null),
      carriers: [...new Set(segs.map((s) => s.carrier_name).filter((n): n is string => !!n))],
      quantityPerRow,
    };
  }

  // A visit belongs to the selected DATE when any of its own segments starts
  // on it — the same day a Needs review badge for it shows on Inputs.
  const touchesDate = (c: CandidateRun) =>
    c.segmentIds.some((id) => {
      const s = segById.get(id);
      return !!s && s.started_at >= dayStart && s.started_at < dayEnd;
    });

  const unitFor = (densityType: "plants" | "stems") => (densityType === "plants" ? "plants/hour" : "stems/hour");
  const preview = (quantity: number, durationSeconds: number): SpeedPreview => ({
    quantity,
    durationSeconds,
    speedPerHour: aggregateDensitySpeed([{ quantityPerRow: quantity, durationSeconds }]),
  });

  const groups: SpeedReviewGroup[] = [];
  for (const cycle of ambiguousCycles) {
    const inScope = cycle.candidates.filter((c) => (employeeId === null || c.employeeId === employeeId) && touchesDate(c));
    const byEmployee = new Map<string, CandidateRun[]>();
    for (const c of inScope) byEmployee.set(c.employeeId, [...(byEmployee.get(c.employeeId) ?? []), c]);

    for (const [empId, empCandidates] of byEmployee) {
      const memberIds = new Set(empCandidates.map((c) => c.runId));
      const visits = empCandidates.map((c) => toVisit(c, cycle.densityType)).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      const contextVisits = cycle.candidates
        .filter((c) => !memberIds.has(c.runId))
        .map((c) => toVisit(c, cycle.densityType))
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      const first = empCandidates[0];

      const reasons: string[] = [];
      if (visits.length > 1) {
        reasons.push(`${first.employeeName} worked ${first.rowLabel} ${visits.length} separate times on ${formatShortDate(opts.date)}.`);
      }
      if (contextVisits.length > 0) {
        const who = contextVisits.map((v) => `${v.employeeName} (${formatShortDate(v.date)})`);
        reasons.push(
          `${first.rowLabel} also has ${contextVisits.length === 1 ? "another visit" : `${contextVisits.length} other visits`} less than 7 days apart: ${who.join(", ")}.`
        );
      }

      const openVisit = visits.find((v) => v.isOpen);
      const mixedDensity = visits.find((v) => v.quantityPerRow === null);
      const zeroDuration = visits.find((v) => !v.isOpen && v.durationSeconds <= 0);

      let separateReason: string | null = null;
      if (openVisit) separateReason = "A visit is still in progress — it can be reviewed once it ends.";
      else if (mixedDensity) separateReason = "A visit has different stems-per-row values on its segments (the density setting changed mid-visit) — review it individually.";
      else if (zeroDuration) separateReason = "A visit has no recorded work time, so no speed can be calculated.";

      let mergeReason: string | null = separateReason;
      if (!mergeReason && visits.length < 2) {
        mergeReason =
          contextVisits.length > 0
            ? "Only one visit by this employee on this date — the other visits are by different employees or on different dates and are never merged."
            : "Only one visit — nothing to merge.";
      } else if (!mergeReason && new Set(visits.map((v) => v.quantityPerRow)).size > 1) {
        mergeReason = "These visits recorded different stems-per-row values, so they can't count as one row.";
      }

      const totalDuration = visits.reduce((s, v) => s + v.durationSeconds, 0);
      groups.push({
        id: `${cycle.key}:${empId}:${opts.date}`,
        employeeId: empId,
        employeeName: first.employeeName,
        date: opts.date,
        activityId: first.activityId,
        activityName: first.activityName,
        greenhouseRowId: first.greenhouseRowId,
        rowLabel: first.rowLabel,
        densityType: cycle.densityType,
        unit: unitFor(cycle.densityType),
        reasons,
        visits,
        contextVisits,
        actions: {
          merge: {
            available: mergeReason === null,
            unavailableReason: mergeReason,
            preview: mergeReason === null ? preview(visits[0].quantityPerRow!, totalDuration) : null,
          },
          separate: {
            available: separateReason === null,
            unavailableReason: separateReason,
            previews:
              separateReason === null
                ? visits.map((v) => ({ visitId: v.visitId, ...preview(v.quantityPerRow!, v.durationSeconds) }))
                : null,
          },
        },
        // Same employee back on the same row the same day reads as one row
        // being finished in pieces; one visit beside other people's visits
        // reads as separate passes. Only a suggestion — never pre-applied.
        suggestedAction: mergeReason === null ? "merge" : separateReason === null ? "separate" : null,
      });
    }
  }

  groups.sort(
    (a, b) =>
      a.employeeName.localeCompare(b.employeeName) ||
      a.visits[0].startedAt.localeCompare(b.visits[0].startedAt) ||
      a.id.localeCompare(b.id)
  );
  return groups;
}
