// Bar colours for TV ranking slides (061_display_slide_colours.sql).
export const DEFAULT_AT_TARGET_COLOR = "#15803d";
export const DEFAULT_BELOW_TARGET_COLOR = "#dc2626";

// Accepts #rgb or #rrggbb (any case); returns lowercase #rrggbb, or null if
// the value isn't a hex colour.
export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return null;
}
