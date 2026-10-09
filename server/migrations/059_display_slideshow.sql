-- TV slideshow for greenhouse displays: the existing map plus one employee
-- speed-ranking slide per activity an administrator sends to that TV.
-- Settings are PER DISPLAY, so two TVs can show different slides.
--
-- Backward compatible by construction:
--  - map_date_preset is null for every existing display = "fixed dates",
--    exactly what date_start/date_end meant before. A non-null preset
--    ('today', 'thisWeek', ...) makes the map's dates advance on their own;
--    date_start/date_end then hold the dates as of the last publish.
--  - a display with no greenhouse_display_activity_slides rows sends no
--    activity to the TV, so it keeps showing only the map, as before.

alter table greenhouse_displays
  add column map_date_preset text,
  add column report_week text not null default 'this_week',
  add column report_include_today boolean not null default true,
  add column map_slide_seconds integer not null default 20;

alter table greenhouse_displays
  add constraint chk_greenhouse_displays_map_date_preset
    check (map_date_preset is null or map_date_preset in
      ('today', 'yesterday', 'thisWeek', 'lastWeek', 'last7', 'thisMonth', 'lastMonth')),
  add constraint chk_greenhouse_displays_report_week
    check (report_week in ('this_week', 'last_week')),
  add constraint chk_greenhouse_displays_map_slide_seconds
    check (map_slide_seconds between 5 and 600);

create table greenhouse_display_activity_slides (
  display_id uuid not null references greenhouse_displays(id) on delete cascade,
  activity_id uuid not null references activities(id) on delete cascade,
  send_to_tv boolean not null default false,
  -- Null = use the activity's own normal_speed. Never written back to the
  -- activity: a display-specific target only changes this TV's slide.
  target_override numeric,
  minimum_activity_hours numeric not null default 0,
  -- Null = show everyone (All); otherwise the top N by speed.
  top_n integer,
  slide_seconds integer not null default 15,
  updated_at timestamptz not null default now(),
  updated_by_employee_id uuid references employees(id),
  primary key (display_id, activity_id),
  constraint chk_display_slides_target check (target_override is null or target_override > 0),
  constraint chk_display_slides_min_hours check (minimum_activity_hours >= 0 and minimum_activity_hours <= 168),
  constraint chk_display_slides_top_n check (top_n is null or top_n between 1 and 200),
  constraint chk_display_slides_seconds check (slide_seconds between 5 and 600)
);
