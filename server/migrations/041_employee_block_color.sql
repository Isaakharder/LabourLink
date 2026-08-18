-- Employee Block colour: a fixed preset palette KEY (never arbitrary
-- client-supplied CSS) so the greenhouse live map can highlight each
-- block's unfinished rows with a soft, muted colour instead of the
-- default blue. The actual fill/stroke shades live in application code
-- (server/src/lib/employeeBlockColors.ts, mirrored in
-- web/src/lib/employeeBlockColors.ts for rendering — keep both in sync);
-- this column and its check constraint are only the storage/enforcement
-- boundary, matching the same "stable key, not raw CSS" reasoning already
-- used elsewhere in this app (e.g. saved_reports' metric lists).
alter table employee_blocks add column color_key text;

-- Deterministic, stable backfill for every block that already existed
-- before this migration: round-robins the same 8-key palette in creation
-- order. Runs exactly once (this migration never re-runs), so every
-- existing block keeps this assigned colour forever after — a later block
-- is instead colour-assigned by the application itself at INSERT time
-- (server/src/routes/employeeBlocks.ts), preferring whichever preset is
-- currently least-used, not this round-robin.
with ordered as (
  select id, row_number() over (order by created_at, id) - 1 as rn
  from employee_blocks
)
update employee_blocks eb
set color_key = (array[
  'slate', 'dustyPurple', 'softMauve', 'warmTaupe',
  'mutedTerracotta', 'softPlum', 'blueGrey', 'mutedAmber'
])[(ordered.rn % 8) + 1]
from ordered
where ordered.id = eb.id;

alter table employee_blocks alter column color_key set not null;

alter table employee_blocks add constraint chk_employee_blocks_color_key
  check (color_key in (
    'slate', 'dustyPurple', 'softMauve', 'warmTaupe',
    'mutedTerracotta', 'softPlum', 'blueGrey', 'mutedAmber'
  ));
