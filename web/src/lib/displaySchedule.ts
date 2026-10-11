// TV slide schedules (Display → Setup). The server decides what the TV shows
// (server/src/lib/displaySchedule.ts); this only describes a schedule for
// the Setup page. Days are ISO weekdays, 1 = Monday … 7 = Sunday; times are
// "HH:MM" in the organization's time zone. An end at or before the start
// runs past midnight into the next day; start = end is a full 24 hours.

export interface SlideSchedule {
  enabled: boolean;
  days: number[];
  start: string;
  end: string;
}

export const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function formatClock(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h < 12 ? "AM" : "PM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

// "Mon–Fri", "Sat–Sun", "Mon, Wed, Fri", "Every day".
export function formatDays(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 7) return "Every day";
  if (sorted.length === 0) return "No days";
  const runs: number[][] = [];
  for (const d of sorted) {
    const run = runs[runs.length - 1];
    if (run && d === run[run.length - 1] + 1) run.push(d);
    else runs.push([d]);
  }
  return runs
    .map((r) => (r.length >= 2 ? `${DAY_SHORT[r[0] - 1]}–${DAY_SHORT[r[r.length - 1] - 1]}` : DAY_SHORT[r[0] - 1]))
    .join(", ");
}

export function endsNextDay(s: SlideSchedule): boolean {
  return s.end <= s.start;
}

// One line for the card: "Always shown" or "Mon–Fri · 6:00 AM–6:00 PM".
export function summarizeSchedule(s: SlideSchedule): string {
  if (!s.enabled) return "Always shown";
  const days = formatDays(s.days);
  if (s.start === s.end) {
    return s.start === "00:00" ? `${days} · all day` : `${days} · 24 h from ${formatClock(s.start)}`;
  }
  return `${days} · ${formatClock(s.start)}–${formatClock(s.end)}${endsNextDay(s) ? " (next day)" : ""}`;
}
