import { InputsEmployee } from "../../lib/inputsTypes";
import { secondsToHoursMinutes } from "../../lib/reportTypes";

interface EmployeeListPanelProps {
  employees: InputsEmployee[] | null;
  error: string | null;
  // True while a fresh employees+totals request for the currently selected
  // date/search is in flight — distinct from `employees === null` (the
  // panel's own first-load "Loading..." text below). Once the roster has
  // loaded once, a still-displayed row's paid-hours value is only ever
  // shown when it's confirmed fresh for the current date; while `loading`
  // is true each row shows a placeholder instead of the (possibly
  // previous-date, now stale) number it already has — see InputsPage.tsx's
  // loadEmployees.
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
}

// "8 hours paid" / "7 hours 45 minutes paid" / "0 hours paid" — the
// accessible label for a row's compact "8:00"/"7:45"/"0:00" visible value
// (both the native title tooltip and aria-label), spelled out in full since
// the visible H:MM form alone doesn't say "hours," "minutes," or "paid" out
// loud. Rounds to the nearest minute, same as secondsToHoursMinutes itself,
// so the two never disagree on a boundary value.
function paidHoursLabel(seconds: number): string {
  const totalMinutes = Math.round(Math.max(0, seconds) / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const hourPart = `${h} hour${h === 1 ? "" : "s"}`;
  const minutePart = m > 0 ? ` ${m} minute${m === 1 ? "" : "s"}` : "";
  return `${hourPart}${minutePart} paid`;
}

interface HoursDisplay {
  // What the row shows in place of the placeholder bar — always "" while
  // isPlaceholder is true (the placeholder <span> below is what actually
  // renders then).
  text: string;
  label: string;
  isPlaceholder: boolean;
}

// The three states a row's hours cell can be in, collapsed to one place so
// the render below never has to juggle loading/null/real-value branching
// itself. `paidSeconds === null` is the server's explicit "couldn't be
// computed" signal (see inputsTypes.ts) — kept visually and semantically
// distinct from a genuine, successfully-computed 0 (secondsToHoursMinutes
// would render both as text, so this has to branch before ever calling it).
function hoursDisplay(paidSeconds: number | null, loading: boolean): HoursDisplay {
  if (loading) return { text: "", label: "Paid hours loading", isPlaceholder: true };
  if (paidSeconds === null) return { text: "—", label: "Paid hours unavailable", isPlaceholder: false };
  return { text: secondsToHoursMinutes(paidSeconds), label: paidHoursLabel(paidSeconds), isPlaceholder: false };
}

export function EmployeeListPanel({
  employees,
  error,
  loading,
  selectedId,
  onSelect,
  search,
  onSearchChange,
}: EmployeeListPanelProps) {
  return (
    <div className="inputs-employee-panel">
      <input
        type="search"
        placeholder="Search employees"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        className="inputs-employee-search"
      />
      {error ? (
        <p className="error-text">{error}</p>
      ) : !employees ? (
        <p>Loading...</p>
      ) : employees.length === 0 ? (
        <p className="placeholder-page">No active employees found.</p>
      ) : (
        <ul className="inputs-employee-list">
          {employees.map((e) => {
            const hours = hoursDisplay(e.paidSeconds, loading);
            return (
              <li key={e.id}>
                <button
                  type="button"
                  className={`inputs-employee-item${e.id === selectedId ? " inputs-employee-item-selected" : ""}`}
                  onClick={() => onSelect(e.id)}
                >
                  <span className="inputs-employee-name">
                    {e.firstName} {e.lastName}
                  </span>
                  <span
                    className="inputs-employee-hours"
                    title={hours.isPlaceholder ? undefined : hours.label}
                    aria-label={hours.label}
                  >
                    {hours.isPlaceholder ? <span className="inputs-employee-hours-placeholder" aria-hidden="true" /> : hours.text}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
