-- Display → Map: which phases of the display's land the TV map shows, per
-- display (e.g. Upstairs shows Phases 1–2, Break Area TV shows Phase 3).
--
-- null = every active phase of the land, including phases added later. Every
-- display that exists when this runs keeps null, so it keeps showing all
-- phases exactly as before (the office page's old phase dropdown was a
-- preview-only filter and was never published, so no display was limited to
-- one phase). A non-null list is never empty (the publish route requires at
-- least one phase) and only ever holds phases of the display's land; ids of
-- phases later deleted or deactivated are ignored when the map is built.
alter table greenhouse_displays add column map_phase_ids uuid[];

alter table greenhouse_displays add constraint chk_greenhouse_displays_map_phase_ids_not_empty
  check (map_phase_ids is null or cardinality(map_phase_ids) > 0);
