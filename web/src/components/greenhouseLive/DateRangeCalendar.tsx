import { useEffect, useMemo, useState } from "react";
import { addCalendarDays, todayInAppTimezone } from "../../lib/timezone";

interface DateRangeCalendarProps {
  value: { start: string; end: string } | null; // YYYY-MM-DD
  onChange: (range: { start: string; end: string }) => void;
}

const WEEKDAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const MONTH_FORMAT = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" });

function mondayOffset(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
  return (day + 6) % 7; // days back to the preceding Monday
}

// 42 consecutive YYYY-MM-DD strings (6 full Monday-start weeks) covering the
// given month plus its leading/trailing days from neighboring months, the
// same way any standard month-grid calendar renders.
function buildGrid(year: number, month: number): string[] {
  const firstOfMonth = `${year}-${String(month).padStart(2, "0")}-01`;
  const gridStart = addCalendarDays(firstOfMonth, -mondayOffset(firstOfMonth));
  const days: string[] = [];
  for (let i = 0; i < 42; i++) days.push(addCalendarDays(gridStart, i));
  return days;
}

export function DateRangeCalendar({ value, onChange }: DateRangeCalendarProps) {
  const anchorDate = value?.end ?? todayInAppTimezone();
  const [anchorY, anchorM] = anchorDate.split("-").map(Number);
  const [visibleYear, setVisibleYear] = useState(anchorY);
  const [visibleMonth, setVisibleMonth] = useState(anchorM); // 1-12

  const [dragAnchor, setDragAnchor] = useState<string | null>(null);
  const [dragPreviewEnd, setDragPreviewEnd] = useState<string | null>(null);
  const [clickPending, setClickPending] = useState<string | null>(null);

  // Committing a drag or the second click of the click-click fallback both
  // happen on a window-level mouseup — a drag can end with the pointer
  // outside the grid entirely (e.g. released past the last row), and that
  // release must still commit the range.
  useEffect(() => {
    function onMouseUp() {
      if (!dragAnchor) return;
      const anchor = dragAnchor;
      const previewEnd = dragPreviewEnd ?? dragAnchor;
      setDragAnchor(null);
      setDragPreviewEnd(null);

      if (previewEnd !== anchor) {
        // A genuine drag across cells — commit immediately.
        const [start, end] = [anchor, previewEnd].sort();
        onChange({ start, end });
        setClickPending(null);
        return;
      }

      // No movement — a plain click. First click of a pair sets the start
      // only (per "first click chooses start"); the second commits.
      if (clickPending) {
        const [start, end] = [clickPending, anchor].sort();
        onChange({ start, end });
        setClickPending(null);
      } else {
        setClickPending(anchor);
      }
    }
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
  }, [dragAnchor, dragPreviewEnd, clickPending, onChange]);

  const grid = useMemo(() => buildGrid(visibleYear, visibleMonth), [visibleYear, visibleMonth]);

  const highlightRange = dragAnchor
    ? ([dragAnchor, dragPreviewEnd ?? dragAnchor].sort() as [string, string])
    : clickPending
      ? ([clickPending, clickPending] as [string, string])
      : value
        ? ([value.start, value.end] as [string, string])
        : null;

  function goToPrevMonth() {
    if (visibleMonth === 1) {
      setVisibleYear((y) => y - 1);
      setVisibleMonth(12);
    } else {
      setVisibleMonth((m) => m - 1);
    }
  }

  function goToNextMonth() {
    if (visibleMonth === 12) {
      setVisibleYear((y) => y + 1);
      setVisibleMonth(1);
    } else {
      setVisibleMonth((m) => m + 1);
    }
  }

  return (
    <div className="date-range-calendar" onDragStart={(e) => e.preventDefault()}>
      <div className="date-range-calendar-header">
        <button type="button" onClick={goToPrevMonth} aria-label="Previous month">
          ←
        </button>
        <span>{MONTH_FORMAT.format(new Date(Date.UTC(visibleYear, visibleMonth - 1, 1)))}</span>
        <button type="button" onClick={goToNextMonth} aria-label="Next month">
          →
        </button>
      </div>

      <div className="date-range-calendar-weekdays">
        {WEEKDAY_LABELS.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>

      <div className="date-range-calendar-grid">
        {grid.map((day) => {
          const [, m] = day.split("-").map(Number);
          const inVisibleMonth = m === visibleMonth;
          const inRange = highlightRange && day >= highlightRange[0] && day <= highlightRange[1];
          const isEdge = highlightRange && (day === highlightRange[0] || day === highlightRange[1]);
          const dayNum = Number(day.split("-")[2]);
          return (
            <button
              key={day}
              type="button"
              className={`date-range-calendar-day${inVisibleMonth ? "" : " date-range-calendar-day-outside"}${
                inRange ? " date-range-calendar-day-in-range" : ""
              }${isEdge ? " date-range-calendar-day-edge" : ""}`}
              onMouseDown={() => {
                setDragAnchor(day);
                setDragPreviewEnd(day);
              }}
              onMouseEnter={(e) => {
                if (dragAnchor && e.buttons === 1) setDragPreviewEnd(day);
              }}
            >
              {dayNum}
            </button>
          );
        })}
      </div>
    </div>
  );
}
