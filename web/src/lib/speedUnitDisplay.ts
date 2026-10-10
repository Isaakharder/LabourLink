// How a speed unit is SHOWN on LabourLink's graphs (the TV ranking chart:
// bar labels, its caption and the Target line). Display only — the stored
// activities.speed_unit, API values and every calculation keep the full
// unit. Only "stems/hour" has a short graph form; any other unit (including
// "plants/hour" and free-text units) is shown exactly as stored.
const GRAPH_UNIT_LABELS: Record<string, string> = {
  "stems/hour": "stm/hr",
};

export function graphSpeedUnit(unit: string | null | undefined): string {
  if (!unit) return "";
  return GRAPH_UNIT_LABELS[unit.trim().toLowerCase()] ?? unit;
}
