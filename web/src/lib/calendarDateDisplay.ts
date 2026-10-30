// Formats a date for display. A date-only "YYYY-MM-DD" (start date, date of
// birth, End Different Date) is a calendar date, not an instant, so it's
// built in local time: new Date("YYYY-MM-DD") means midnight UTC, which
// displays as the previous day anywhere west of UTC (Toronto).
export function formatCalendarDate(value: string | null | undefined): string {
  if (!value) return "—";
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const parsed = dateOnly ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])) : new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
