-- Per-activity optional "question" asked on mobile before an employee can
-- start/switch into that activity. v1 supports exactly one question per
-- activity (not a list) and exactly one question type (greenhouse_row —
-- "pick a row"). question_type is a real column, not a hardcoded frontend
-- constant, so a second type can be added later without reshaping this
-- table.
create table activity_questions (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null unique references activities(id),
  question_type text not null check (question_type in ('greenhouse_row')),
  label text not null default 'Where?',
  is_required boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- No deleted_at/is_active here unlike activities/greenhouse_rows: nothing
-- ever references an activity_questions row by FK, and "question disabled"
-- has no history worth keeping — turning a question off just deletes the
-- row (see PUT /api/activities/:id/questions).
