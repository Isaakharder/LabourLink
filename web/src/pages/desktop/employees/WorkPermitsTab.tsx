import { WorkPermitAlertsSection } from "../../../components/employees/WorkPermitAlertsSection";

// Employees -> Work Permits (Administrator/Manager). The alerts used to sit
// at the top of the Dashboard; the alert rules, the actions and their
// permissions are unchanged.
export function WorkPermitsTab() {
  return (
    <div className="work-permits-tab">
      <WorkPermitAlertsSection />
    </div>
  );
}
