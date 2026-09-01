import { useEffect, useRef, useState } from "react";
import { addCalendarDays, formatDateLong } from "../../lib/timezone";
import { InputsDateCalendar } from "./InputsDateCalendar";

interface DateNavProps {
  date: string;
  onChange: (date: string) => void;
}

export function DateNav({ date, onChange }: DateNavProps) {
  const [calendarOpen, setCalendarOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!calendarOpen) return;
    function onPointerDown(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setCalendarOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setCalendarOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [calendarOpen]);

  function handleSelect(newDate: string) {
    onChange(newDate);
    setCalendarOpen(false);
    triggerRef.current?.focus();
  }

  return (
    <div className="inputs-date-nav">
      <button type="button" onClick={() => onChange(addCalendarDays(date, -1))} aria-label="Previous day">
        ←
      </button>
      <div className="inputs-date-display" ref={containerRef}>
        <button
          type="button"
          ref={triggerRef}
          className="inputs-date-long inputs-date-trigger"
          onClick={() => setCalendarOpen((open) => !open)}
          aria-haspopup="dialog"
          aria-expanded={calendarOpen}
          aria-label="Choose Inputs date"
        >
          {formatDateLong(date)}
        </button>
        {calendarOpen && (
          <InputsDateCalendar
            selectedDate={date}
            onSelect={handleSelect}
            onClose={() => {
              setCalendarOpen(false);
              triggerRef.current?.focus();
            }}
          />
        )}
      </div>
      <button type="button" onClick={() => onChange(addCalendarDays(date, 1))} aria-label="Next day">
        →
      </button>
    </div>
  );
}
