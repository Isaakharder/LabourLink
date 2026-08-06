-- Persisted map-rotation setting for a greenhouse display (office draft +
-- published TV config) — a pure viewing transform applied only at render
-- time (see web/src/lib/canvasTransform.ts / GreenhouseLiveCanvas.tsx).
-- Never touches greenhouse_phases/greenhouse_rows coordinates. 0 = normal;
-- 90/180/270 = clockwise steps, matching the office Rotate button's
-- four-state cycle (0 -> 90 -> 180 -> 270 -> 0).
alter table greenhouse_displays
  add column rotation_degrees integer not null default 0;

alter table greenhouse_displays
  add constraint chk_greenhouse_displays_rotation_degrees
  check (rotation_degrees in (0, 90, 180, 270));
