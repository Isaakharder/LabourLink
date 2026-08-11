import { Avatar } from "../employees/Avatar";
import { InputsEmployee } from "../../lib/inputsTypes";

interface InputsSkeletonProps {
  // The newly-selected employee, looked up from the already-loaded
  // EmployeeListPanel list (a plain client-side find, no network call) —
  // present the instant the selection changes, well before GET /daily
  // resolves, so the skeleton shows who is loading, not just that
  // something is. null only while the employee list itself hasn't loaded
  // yet (first-ever page visit).
  employee: InputsEmployee | null;
}

// Shown in place of ActivityLogsCard/WorkdayDetailsCard the instant the
// selected employee or date changes and InputsPage has cleared `daily` —
// see InputsPage's employee/date-change effect. Deliberately mirrors their
// header shape (avatar + name) so the transition from skeleton to real
// content doesn't jump, while every data-dependent row is a plain animated
// placeholder rather than the previous employee's real numbers.
export function InputsSkeleton({ employee }: InputsSkeletonProps) {
  return (
    <div className="inputs-skeleton" aria-busy="true" aria-label="Loading employee data">
      <div className="inputs-section-header">
        <h3>Activity details</h3>
      </div>
      <div className="inputs-logs-header">
        <Avatar
          photoUrl={employee?.photoUrl ?? null}
          firstName={employee?.firstName ?? ""}
          lastName={employee?.lastName ?? ""}
          size="large"
        />
        <div className="inputs-logs-header-text">
          <h2>{employee ? `${employee.firstName} ${employee.lastName}` : ""}</h2>
          <p className="inputs-skeleton-status">Loading…</p>
        </div>
      </div>
      <div className="inputs-skeleton-rows">
        {[0, 1, 2].map((i) => (
          <div key={i} className="inputs-skeleton-row">
            <span className="inputs-skeleton-bar inputs-skeleton-bar-wide" />
            <span className="inputs-skeleton-bar" />
            <span className="inputs-skeleton-bar" />
            <span className="inputs-skeleton-bar inputs-skeleton-bar-narrow" />
          </div>
        ))}
      </div>

      <div className="inputs-section-header">
        <h3>Workday details</h3>
      </div>
      <div className="inputs-skeleton-rows">
        {[0, 1].map((i) => (
          <div key={i} className="inputs-skeleton-row">
            <span className="inputs-skeleton-bar inputs-skeleton-bar-wide" />
            <span className="inputs-skeleton-bar" />
            <span className="inputs-skeleton-bar" />
          </div>
        ))}
      </div>
    </div>
  );
}
