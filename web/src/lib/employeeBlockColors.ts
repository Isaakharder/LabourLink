// Fixed preset palette for Employee Block colour-coding on the greenhouse
// live map — mirrors server/src/lib/employeeBlockColors.ts's key list
// exactly (keep both in sync); this file additionally carries the actual
// soft/muted fill+stroke shades used for rendering, which the server side
// never needs (it only validates the key).
//
// Every fill is a light, low-saturation tint (~85-90% lightness) and every
// stroke a medium, muted shade (~35-45% lightness, moderate saturation) of
// the same hue — soft enough to read as "calm and professional," while the
// stroke stays dark enough to remain visible as a thin SVG row outline
// (vector-effect="non-scaling-stroke" in GreenhouseLiveCanvas.tsx) against
// the map's light background. Deliberately kept clear of the app's other
// fixed map colours: default blue (#2563eb/#1d4ed8), completed green
// (#16a34a/#15803d), the Employee Blocks Link Rows selection palette's
// vivid amber "selected" (#f59e0b/#b45309) and red "taken" (#ef4444/
// #b91c1c) — mutedAmber/mutedTerracotta below are both visibly duller and
// darker than those two so they're never confused at a glance.
export const EMPLOYEE_BLOCK_COLOR_KEYS = [
  "slate",
  "dustyPurple",
  "softMauve",
  "warmTaupe",
  "mutedTerracotta",
  "softPlum",
  "blueGrey",
  "mutedAmber",
] as const;

export type EmployeeBlockColorKey = (typeof EMPLOYEE_BLOCK_COLOR_KEYS)[number];

export interface EmployeeBlockColorDef {
  key: EmployeeBlockColorKey;
  label: string;
  fill: string;
  stroke: string;
}

export const EMPLOYEE_BLOCK_COLORS: Record<EmployeeBlockColorKey, EmployeeBlockColorDef> = {
  slate: { key: "slate", label: "Slate", fill: "#dde3ea", stroke: "#5b6b7c" },
  dustyPurple: { key: "dustyPurple", label: "Dusty Purple", fill: "#e6def2", stroke: "#7c6a9c" },
  softMauve: { key: "softMauve", label: "Soft Mauve", fill: "#f0dee4", stroke: "#a06b82" },
  warmTaupe: { key: "warmTaupe", label: "Warm Taupe", fill: "#ece3d6", stroke: "#8a7458" },
  mutedTerracotta: { key: "mutedTerracotta", label: "Muted Terracotta", fill: "#f0ddd2", stroke: "#b5714f" },
  softPlum: { key: "softPlum", label: "Soft Plum", fill: "#e9dbe7", stroke: "#8c5a80" },
  blueGrey: { key: "blueGrey", label: "Blue-Grey", fill: "#dbe5ea", stroke: "#4f7080" },
  mutedAmber: { key: "mutedAmber", label: "Muted Amber", fill: "#f2e6cc", stroke: "#a3792f" },
};

export function isEmployeeBlockColorKey(v: string): v is EmployeeBlockColorKey {
  return (EMPLOYEE_BLOCK_COLOR_KEYS as readonly string[]).includes(v);
}

export function employeeBlockColorDef(key: string | null | undefined): EmployeeBlockColorDef | null {
  return key && isEmployeeBlockColorKey(key) ? EMPLOYEE_BLOCK_COLORS[key] : null;
}
