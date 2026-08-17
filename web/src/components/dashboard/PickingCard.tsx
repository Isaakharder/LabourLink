import { Avatar } from "../employees/Avatar";
import { PickingDashboardCard } from "../../lib/dashboardTypes";

function formatSpeed(speed: number | null): string {
  // Genuinely bins/hour, not kg/hour — there is no weight-capture anywhere
  // in this app (see carrierCompletionAttribution.ts's own file header);
  // labeled honestly here rather than implying a weight measurement that
  // was never taken.
  if (speed == null) return "Not enough data";
  return `${speed.toFixed(2)} bins/hour`;
}

export function PickingCard({ card }: { card: PickingDashboardCard }) {
  return (
    <div className="dashboard-card">
      <div className="dashboard-card-header">
        <Avatar photoUrl={card.photoUrl} firstName={card.employeeFirstName} lastName={card.employeeLastName} />
        <div>
          <div className="dashboard-card-name">
            {card.employeeFirstName} {card.employeeLastName}
          </div>
          <div className="dashboard-card-activity">{card.activityName}</div>
        </div>
      </div>

      <dl className="dashboard-card-stats">
        <dt>Average picking speed</dt>
        <dd>{formatSpeed(card.weeklySpeed)}</dd>

        <dt>Rows completed this week</dt>
        <dd>{card.rowsWorkedThisWeek}</dd>

        <dt>Bins completed this week</dt>
        <dd>{card.binsCompletedThisWeek}</dd>
      </dl>

      <p className="dashboard-card-hint">
        Rows and bins are separate counts — a row can yield any number of bins, so these are not expected to divide
        evenly into each other.
      </p>
    </div>
  );
}
