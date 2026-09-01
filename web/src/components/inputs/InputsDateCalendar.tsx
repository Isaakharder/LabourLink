import { KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  addCalendarDays,
  endOfMonth,
  startOfMonth,
  startOfWeekMonday,
  todayInAppTimezone,
} from "../../lib/timezone";

interface InputsDateCalendarProps {
  // The currently-selected Inputs date (YYYY-MM-DD) — highlighted in the grid.
  selectedDate: string;
  // Called with a plain YYYY-MM-DD when the user picks a day. The caller is
  // responsible for closing the popover and reloading data — this
  // component only reports the choice.
  onSelect: (date: string) => void;
  onClose: () => void;
}

const WEEKDAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function parseYmd(dateStr: string): { year: number; month: number; day: number } {
  const [y, m, d] = dateStr.split("-").map(Number);
  return { year: y, month: m, day: d };
}

function toYmd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Adds `deltaMonths` calendar months to `dateStr`'s year/month, clamped to
// the target month's own day-1 (the grid only ever needs the month's
// identity, never a specific day-of-month) — avoids the classic "Jan 31 + 1
// month" overflow into March that plain Date arithmetic would produce.
function addCalendarMonths(dateStr: string, deltaMonths: number): string {
  const { year, month } = parseYmd(dateStr);
  const totalMonths = (year * 12 + (month - 1)) + deltaMonths;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = (totalMonths % 12) + 1;
  return toYmd(targetYear, targetMonth, 1);
}

// 42 consecutive YYYY-MM-DD cells (6 Monday-start weeks) covering the month
// containing `visibleMonth` — a fixed 6 rows so the grid's height never
// jumps as the user navigates between months.
function buildCalendarGrid(visibleMonth: string): string[] {
  const gridStart = startOfWeekMonday(startOfMonth(visibleMonth));
  const cells: string[] = [];
  let cursor = gridStart;
  for (let i = 0; i < 42; i++) {
    cells.push(cursor);
    cursor = addCalendarDays(cursor, 1);
  }
  return cells;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function InputsDateCalendar({ selectedDate, onSelect, onClose }: InputsDateCalendarProps) {
  const today = useMemo(() => todayInAppTimezone(), []);
  const [visibleMonth, setVisibleMonth] = useState(() => startOfMonth(selectedDate));
  const [focusedDate, setFocusedDate] = useState(selectedDate);
  const dayButtonRefs = useRef(new Map<string, HTMLButtonElement | null>());

  const grid = useMemo(() => buildCalendarGrid(visibleMonth), [visibleMonth]);
  const { year: visibleYear, month: visibleMonthNum } = parseYmd(visibleMonth);

  // Wide but bounded so the year <select> stays a reasonable size while
  // still letting a user jump decades in one pick rather than clicking
  // "next month" hundreds of times.
  const todayYear = parseYmd(today).year;
  const yearOptions = useMemo(() => {
    const years: number[] = [];
    for (let y = todayYear - 75; y <= todayYear + 5; y++) years.push(y);
    return years;
  }, [todayYear]);

  useEffect(() => {
    dayButtonRefs.current.get(focusedDate)?.focus();
  }, [focusedDate, visibleMonth]);

  function goToMonth(next: string) {
    setVisibleMonth(startOfMonth(next));
    // Keep the same day-of-month when possible, clamped into the new month.
    const { day } = parseYmd(focusedDate);
    const lastDay = parseYmd(endOfMonth(next)).day;
    setFocusedDate(toYmd(parseYmd(next).year, parseYmd(next).month, Math.min(day, lastDay)));
  }

  function handleMonthSelect(monthNum: number) {
    goToMonth(toYmd(visibleYear, monthNum, 1));
  }

  function handleYearSelect(year: number) {
    goToMonth(toYmd(year, visibleMonthNum, 1));
  }

  function selectDay(dateStr: string) {
    onSelect(dateStr);
  }

  function handleGridKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    let target: string | null = null;
    switch (e.key) {
      case "ArrowLeft":
        target = addCalendarDays(focusedDate, -1);
        break;
      case "ArrowRight":
        target = addCalendarDays(focusedDate, 1);
        break;
      case "ArrowUp":
        target = addCalendarDays(focusedDate, -7);
        break;
      case "ArrowDown":
        target = addCalendarDays(focusedDate, 7);
        break;
      case "Home":
        target = startOfWeekMonday(focusedDate);
        break;
      case "End":
        target = addCalendarDays(startOfWeekMonday(focusedDate), 6);
        break;
      case "PageUp":
        target = addCalendarMonths(focusedDate, e.shiftKey ? -12 : -1);
        break;
      case "PageDown":
        target = addCalendarMonths(focusedDate, e.shiftKey ? 12 : 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        selectDay(focusedDate);
        return;
      case "Escape":
        e.preventDefault();
        onClose();
        return;
      default:
        return;
    }
    e.preventDefault();
    if (startOfMonth(target) !== visibleMonth) setVisibleMonth(startOfMonth(target));
    setFocusedDate(target);
  }

  return (
    <div className="inputs-date-calendar" role="dialog" aria-label="Choose Inputs date">
      <div className="inputs-date-calendar-header">
        <button
          type="button"
          className="inputs-date-calendar-nav-btn"
          onClick={() => goToMonth(addCalendarMonths(visibleMonth, -1))}
          aria-label="Previous month"
        >
          ‹
        </button>
        <select
          className="inputs-date-calendar-select"
          value={visibleMonthNum}
          onChange={(e) => handleMonthSelect(Number(e.target.value))}
          aria-label="Month"
        >
          {MONTH_NAMES.map((name, idx) => (
            <option key={name} value={idx + 1}>
              {name}
            </option>
          ))}
        </select>
        <select
          className="inputs-date-calendar-select"
          value={visibleYear}
          onChange={(e) => handleYearSelect(Number(e.target.value))}
          aria-label="Year"
        >
          {yearOptions.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="inputs-date-calendar-nav-btn"
          onClick={() => goToMonth(addCalendarMonths(visibleMonth, 1))}
          aria-label="Next month"
        >
          ›
        </button>
      </div>

      <div className="inputs-date-calendar-weekdays">
        {WEEKDAY_LABELS.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>

      <div className="inputs-date-calendar-grid" onKeyDown={handleGridKeyDown}>
        {grid.map((cellDate) => {
          const inMonth = startOfMonth(cellDate) === visibleMonth;
          const isToday = cellDate === today;
          const isSelected = cellDate === selectedDate;
          const day = parseYmd(cellDate).day;
          return (
            <button
              key={cellDate}
              type="button"
              ref={(el) => {
                dayButtonRefs.current.set(cellDate, el);
              }}
              tabIndex={cellDate === focusedDate ? 0 : -1}
              className={[
                "inputs-date-calendar-day",
                !inMonth ? "inputs-date-calendar-day-outside" : "",
                isToday ? "inputs-date-calendar-day-today" : "",
                isSelected ? "inputs-date-calendar-day-selected" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => selectDay(cellDate)}
              onFocus={() => setFocusedDate(cellDate)}
              aria-current={isToday ? "date" : undefined}
              aria-pressed={isSelected}
            >
              {day}
            </button>
          );
        })}
      </div>
    </div>
  );
}
