-- Replaces v1's one-question-per-activity limitation (014_activity_questions.sql)
-- with an ordered list: an activity may now have zero, one, or many
-- questions, asked in sort_order on mobile before work starts. Mirrors the
-- break_profile_items pattern (010_break_profiles.sql) — sort_order +
-- is_active, upserted by id, removed rows soft-deactivated rather than
-- hard-deleted, since a later requirement (a generic answer-history table)
-- could reference a question by id and a hard delete would break that.

alter table activity_questions
  drop constraint activity_questions_activity_id_key;

alter table activity_questions
  add column sort_order integer not null default 0,
  add column is_active boolean not null default true;

-- Second supported question type — "Which Carrier?" (see 019_carriers.sql
-- for the carriers table this answers against). question_type stays a real
-- column, not a hardcoded frontend constant, so a third type can be added
-- later the same way.
alter table activity_questions
  drop constraint activity_questions_question_type_check;
alter table activity_questions
  add constraint activity_questions_question_type_check
  check (question_type in ('greenhouse_row', 'carrier'));

-- Existing rows (e.g. Winding & Pruning's "Where?") already default to
-- sort_order 0 and is_active true from the columns above — no explicit
-- backfill needed, and no existing configuration changes as a result of
-- this migration.

-- Ordering must be unambiguous per activity, but only among the questions
-- currently in effect — a soft-deactivated question must never block reusing
-- its old sort_order for a new one.
create unique index activity_questions_activity_sort_active_key
  on activity_questions (activity_id, sort_order)
  where is_active = true;

create index idx_activity_questions_activity_active
  on activity_questions (activity_id)
  where is_active = true;
