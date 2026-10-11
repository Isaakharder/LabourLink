-- Display → Setup: a Send to TV switch and a schedule for the map slide, a
-- schedule for each activity slide, and which Setup cards are hidden — all
-- per display.
--
-- Backward compatible by construction:
--  - map_send_to_tv defaults to true and every *_schedule_enabled to false
--    ("Always show"), so every existing display keeps showing exactly the
--    slides it shows today.
--  - Schedule days are ISO weekdays (1 = Monday … 7 = Sunday) in the
--    organization's time zone (APP_TIMEZONE). A window starts on a chosen day
--    at *_start and ends at *_end; an end at or before the start means the
--    window runs past midnight into the next day (start = end: 24 hours). The
--    stored times are the editor's defaults while a schedule is off.
--  - setup_hidden_cards only tidies the Display → Setup page ('map' or an
--    activity id). It never affects what the TV shows.

alter table greenhouse_displays
  add column map_send_to_tv boolean not null default true,
  add column map_schedule_enabled boolean not null default false,
  add column map_schedule_days smallint[] not null default '{1,2,3,4,5,6,7}',
  add column map_schedule_start time not null default '06:00',
  add column map_schedule_end time not null default '18:00',
  add column setup_hidden_cards text[] not null default '{}';

alter table greenhouse_displays
  add constraint chk_greenhouse_displays_map_schedule_days
    check (map_schedule_days <@ '{1,2,3,4,5,6,7}'::smallint[]),
  add constraint chk_greenhouse_displays_map_schedule_minutes
    check (date_part('second', map_schedule_start) = 0 and date_part('second', map_schedule_end) = 0);

alter table greenhouse_display_activity_slides
  add column schedule_enabled boolean not null default false,
  add column schedule_days smallint[] not null default '{1,2,3,4,5,6,7}',
  add column schedule_start time not null default '06:00',
  add column schedule_end time not null default '18:00';

alter table greenhouse_display_activity_slides
  add constraint chk_display_slides_schedule_days
    check (schedule_days <@ '{1,2,3,4,5,6,7}'::smallint[]),
  add constraint chk_display_slides_schedule_minutes
    check (date_part('second', schedule_start) = 0 and date_part('second', schedule_end) = 0);
