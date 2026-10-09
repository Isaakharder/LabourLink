-- Per-display, per-activity bar colours for TV ranking slides
-- (059_display_slideshow.sql). A bar at or above the slide's target uses
-- at_target_color; below it, below_target_color. Stored as lowercase
-- #rrggbb; existing rows get the defaults (green / red).

alter table greenhouse_display_activity_slides
  add column at_target_color text not null default '#15803d',
  add column below_target_color text not null default '#dc2626';

alter table greenhouse_display_activity_slides
  add constraint chk_display_slides_at_target_color check (at_target_color ~ '^#[0-9a-f]{6}$'),
  add constraint chk_display_slides_below_target_color check (below_target_color ~ '^#[0-9a-f]{6}$');
