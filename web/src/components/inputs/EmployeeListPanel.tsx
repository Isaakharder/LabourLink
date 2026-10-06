import { ReactNode } from "react";
import { InputsEmployee } from "../../lib/inputsTypes";
import { UNGROUPED_LABEL } from "../../lib/employeeGroupTypes";
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
  // Optional control rendered above the search box (Inputs' "Review all
  // employees" bulk speed review button).
  headerAction?: ReactNode;
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

interface EmployeeSection {
  key: string;
  name: string;
  employees: InputsEmployee[];
}

// The list the panel receives is already filtered (date, and search —
// done server-side), so grouping it here makes every heading's count and
// which groups appear follow the current filters automatically: a group
// with no matching employee simply has no section. Groups alphabetical,
// Ungrouped last; employees alphabetical within each group.
export function groupEmployees(employees: InputsEmployee[]): EmployeeSection[] {
  const byKey = new Map<string, EmployeeSection>();
  for (const e of employees) {
    const key = e.employeeGroup?.id ?? "";
    const section = byKey.get(key) ?? { key, name: e.employeeGroup?.name ?? UNGROUPED_LABEL, employees: [] };
    section.employees.push(e);
    byKey.set(key, section);
  }
  const fullName = (e: InputsEmployee) => `${e.firstName} ${e.lastName}`;
  const sections = [...byKey.values()];
  for (const s of sections) s.employees.sort((a, b) => fullName(a).localeCompare(fullName(b)) || a.id.localeCompare(b.id));
  return sections.sort((a, b) => {
    if (a.key === "" || b.key === "") return a.key === "" ? 1 : -1;
    return a.name.localeCompare(b.name) || a.key.localeCompare(b.key);
  });
}

export function EmployeeListPanel({
  employees,
  error,
  loading,
  selectedId,
  onSelect,
  search,
  onSearchChange,
  headerAction,
}: EmployeeListPanelProps) {
  return (
    <div className="inputs-employee-panel">
      {headerAction}
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
        <div className="inputs-employee-groups">
          {groupEmployees(employees).map((section) => (
            <section
              key={section.key || "ungrouped"}
              className="inputs-employee-group"
              aria-label={`${section.name} (${section.employees.length})`}
            >
              <h4 className="inputs-employee-group-heading">
                <span className="inputs-employee-group-name">{section.name}</span>
                <span className="inputs-employee-group-count">{section.employees.length}</span>
              </h4>
              <ul className="inputs-employee-list">
                {section.employees.map((e) => {
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
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
