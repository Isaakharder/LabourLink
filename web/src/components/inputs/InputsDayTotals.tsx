import { InputsWorkingTotals } from "../../lib/inputsTypes";

interface InputsDayTotalsProps {
  // null while the selected date's totals are loading (or failed to load):
  // the previous date's numbers are never shown in the meantime.
  totals: InputsWorkingTotals | null;
}

// "Employees working: 22" plus a per-group breakdown, beside the Inputs
// heading. Distinct employees with work recorded on the selected date
// (finished, in progress or manual; breaks alone don't count), by Employee
// Group — computed server-side by GET /api/inputs/employees' workingTotals,
// unaffected by the sidebar search.
export function InputsDayTotals({ totals }: InputsDayTotalsProps) {
  return (
    <div className="inputs-day-totals" aria-live="polite">
      <span className="inputs-day-totals-total">
        Employees working: <strong>{totals ? totals.total : "—"}</strong>
      </span>
      {totals && totals.groups.length > 0 && (
        <ul className="inputs-day-totals-groups" aria-label="Employees working by group">
          {totals.groups.map((g) => (
            <li key={g.id ?? "ungrouped"} className="inputs-day-totals-group">
              {g.name}: <strong>{g.count}</strong>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
