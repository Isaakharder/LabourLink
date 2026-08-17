import { Avatar } from "../employees/Avatar";
import { RowStemDashboardCard } from "../../lib/dashboardTypes";

function formatSpeed(speed: number | null, densityType: "plants" | "stems"): string {
  if (speed == null) return "Not enough data";
  return `${speed.toFixed(1)} ${densityType}/hour`;
}

function formatHoursRemaining(hours: number): string {
  return `${hours.toFixed(1)} hours remaining`;
}

// Block progress/projection copy lives here, not on the server — the server
// only returns the structured status + numbers (see dashboard.ts's own
// comment on why), this is purely presentation.
function blockStatusLine(card: RowStemDashboardCard): string {
  const block = card.block;
  if (!block) return "No block assigned";
  switch (block.status) {
    case "no_rows_linked":
      return "This block has no rows linked yet";
    case "missing_density":
      return `Missing density data for ${block.rowsMissingDensity} row${block.rowsMissingDensity === 1 ? "" : "s"} in this block`;
    case "complete":
      return "Block complete";
    case "not_enough_data":
      return "Not enough data to project";
    case "in_progress":
      return block.projectedHoursRemaining != null ? formatHoursRemaining(block.projectedHoursRemaining) : "Not enough data to project";
  }
}

export function RowStemCard({ card }: { card: RowStemDashboardCard }) {
  const block = card.block;
  const progressPct = block && block.totalRows > 0 ? Math.round((block.completedRows / block.totalRows) * 100) : 0;

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
        <dt>This week</dt>
        <dd>{formatSpeed(card.weeklySpeed, card.densityType)}</dd>

        <dt>Block</dt>
        <dd>{block ? block.name : "No block assigned"}</dd>

        {block && block.totalRows > 0 && (
          <>
            <dt>Rows completed</dt>
            <dd>
              {block.completedRows} of {block.totalRows} rows
            </dd>
          </>
        )}
      </dl>

      {block && block.totalRows > 0 && (
        <div className="dashboard-card-progress" role="progressbar" aria-valuenow={progressPct} aria-valuemin={0} aria-valuemax={100}>
          <div className="dashboard-card-progress-fill" style={{ width: `${progressPct}%` }} />
        </div>
      )}

      <p className="dashboard-card-remaining">{blockStatusLine(card)}</p>
    </div>
  );
}
