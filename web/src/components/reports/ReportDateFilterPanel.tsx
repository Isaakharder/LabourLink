import { Filter } from "lucide-react";
import { DateRangeCalendar } from "../greenhouseLive/DateRangeCalendar";
import { addCalendarDays, startOfWeekMonday, todayInAppTimezone } from "../../lib/timezone";
import { DateRange } from "../../lib/reportTypes";

interface ReportDateFilterPanelProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
}

function thisWeekRange(): DateRange {
  const thisWeekStart = startOfWeekMonday(todayInAppTimezone());
  return { start: thisWeekStart, end: addCalendarDays(thisWeekStart, 6) };
}

function lastWeekRange(): DateRange {
  const lastWeekStart = addCalendarDays(startOfWeekMonday(todayInAppTimezone()), -7);
  return { start: lastWeekStart, end: addCalendarDays(lastWeekStart, 6) };
}

function sameRange(a: DateRange, b: DateRange): boolean {
  return a.start === b.start && a.end === b.end;
}

function formatRangeLabel(range: DateRange, isCustom: boolean): string {
  const base = range.start === range.end ? range.start : `${range.start} to ${range.end}`;
  return isCustom ? `${base} (Custom)` : base;
}

// Left-hand date filter panel for the report view — date controls only (no
// activity/department/crop/employee filters: this app's reports are already
// scoped to one activity at creation time, and there's no department/crop
// concept in the data model to filter on). Deliberately just This Week,
// Last Week, and the calendar — every other preset/nav control this panel
// used to have was removed per the brief. Wraps the existing greenhouse-live
// date-range calendar rather than building a second date-picker.
export function ReportDateFilterPanel({ value, onChange }: ReportDateFilterPanelProps) {
  const thisWeek = thisWeekRange();
  const lastWeek = lastWeekRange();
  const isThisWeek = sameRange(value, thisWeek);
  const isLastWeek = sameRange(value, lastWeek);
  const isCustom = !isThisWeek && !isLastWeek;

  return (
    <aside className="report-filter-panel">
      <div className="report-filter-panel-header">
        <Filter size={16} aria-hidden="true" />
        <span>Filter</span>
      </div>

      <div className="report-filter-section">
        <h3>Filter on date</h3>

        <div className="report-date-presets-stack">
          <button
            type="button"
            className={`report-date-preset${isThisWeek ? " report-date-preset-active" : ""}`}
            onClick={() => onChange(thisWeek)}
          >
            This Week
          </button>
          <button
            type="button"
            className={`report-date-preset${isLastWeek ? " report-date-preset-active" : ""}`}
            onClick={() => onChange(lastWeek)}
          >
            Last Week
          </button>
        </div>

        {/* Keyed on the selected range: DateRangeCalendar's visible month is
            plain useState seeded from `value` only at mount (see that
            component), so it never follows a later preset-driven change on
            its own — remounting here is what keeps the visible grid pointed
            at the current selection instead of wherever it happened to be
            first shown. Scoped to this call site only; the shared component
            itself (also used by Greenhouse) is untouched. */}
        <DateRangeCalendar key={`${value.start}:${value.end}`} value={value} onChange={onChange} />

        <p className="report-date-range-label">{formatRangeLabel(value, isCustom)}</p>

        <button type="button" className="report-date-clear-button" onClick={() => onChange(thisWeek)}>
          Clear
        </button>
      </div>
    </aside>
  );
}
