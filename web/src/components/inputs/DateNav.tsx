import { addCalendarDays, formatDateLong } from "../../lib/timezone";

interface DateNavProps {
  date: string;
  onChange: (date: string) => void;
}

export function DateNav({ date, onChange }: DateNavProps) {
  return (
    <div className="inputs-date-nav">
      <button type="button" onClick={() => onChange(addCalendarDays(date, -1))} aria-label="Previous day">
        ←
      </button>
      <div className="inputs-date-display">
        <span className="inputs-date-long">{formatDateLong(date)}</span>
        <input
          type="date"
          value={date}
          onChange={(e) => e.target.value && onChange(e.target.value)}
          className="inputs-date-picker"
          aria-label="Select date"
        />
      </div>
      <button type="button" onClick={() => onChange(addCalendarDays(date, 1))} aria-label="Next day">
        →
      </button>
    </div>
  );
}
