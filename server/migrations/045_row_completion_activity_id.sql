-- Fixes the Row Completion Review ambiguity grouping: a row_completions
-- record (and the candidate/ambiguity resolution that leads to one — see
-- rowCompletionCandidates.ts) was scoped by greenhouse_row_id +
-- density_type only, so two entirely independent activities sharing a
-- physical row and density type (e.g. Picking Peppers and Winding & Pruning
-- both on 'stems') got lumped into the same "needs review" group — one
-- activity's work could show up in another's review modal, and confirming
-- one could exclude the other's genuinely-separate visit from ever being
-- auto-counted. Scoping must include activity_id: an ActivityRun (see
-- activityRuns.ts) is already always single-activity by construction (an
-- activity change starts a new run), so this is a safe, always-available
-- third key, never a guess.
alter table row_completions add column activity_id uuid references activities(id);

-- Historical completions predate this column. A completion's activity is
-- unambiguous when every one of its linked segments (row_completion_segments
-- -> time_entries.activity_id) agrees — backfilled below. When they don't
-- (or a completion somehow has no segments), this stays true instead of
-- guessing: the check constraint below then requires activity_id to be
-- explicitly null, marking the record for admin review rather than silently
-- misattributing it.
alter table row_completions add column needs_activity_review boolean not null default false;

-- uuid has no built-in min()/max() aggregate — text is a stand-in sort just
-- to pick one consistent value, same convention reportQueries.ts already
-- uses for the identical problem; only trusted here because the having
-- clause guarantees every row in the group shares the same activity_id.
update row_completions rc
set activity_id = sub.only_activity_id
from (
  select rcs.row_completion_id, min(te.activity_id::text)::uuid as only_activity_id
  from row_completion_segments rcs
  join time_entries te on te.id = rcs.time_entry_id
  group by rcs.row_completion_id
  having count(distinct te.activity_id) = 1
) sub
where sub.row_completion_id = rc.id and rc.activity_id is null;

update row_completions
set needs_activity_review = true
where activity_id is null;

-- Every row is now either cleanly attributed or explicitly flagged — never
-- silently unattributed. New completions (POST /api/row-completions) always
-- populate activity_id directly; only pre-existing rows this backfill
-- couldn't resolve ever carry needs_activity_review = true.
alter table row_completions add constraint row_completions_activity_or_review
  check (activity_id is not null or needs_activity_review);

-- Replaces idx_time_entries_density_row_type (026_row_completions.sql) —
-- every consumer's candidate/ambiguity lookup (getUnresolvedRunsForRow) now
-- filters by activity_id too, so the index must lead with the same three
-- columns the query itself filters on.
drop index idx_time_entries_density_row_type;
create index idx_time_entries_density_row_activity_type
  on time_entries(greenhouse_row_id, activity_id, density_type)
  where density_type is not null and entry_type = 'work' and deleted_at is null;
