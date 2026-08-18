import { LiveBlockSummary } from "../../lib/greenhouseLiveTypes";
import { employeeBlockColorDef } from "../../lib/employeeBlockColors";

interface EmployeeBlockLegendProps {
  blocks: LiveBlockSummary[];
}

// One row per Employee Block currently visible on the map: colour swatch,
// "Block name — Employee name", and completed/total rows — the same
// completedRows/totalRows numbers the Dashboard's own block-progress card
// shows for that employee (see getBlockSummariesForLand's own comment,
// server/src/lib/greenhouseLiveState.ts), so the two pages never disagree.
// Shared by both the office Greenhouse page and the TV display — each
// wraps this in its own `.greenhouse-live-legend`/`.greenhouse-tv-legend`
// container for sizing, this component itself carries no page-specific
// layout assumptions.
export function EmployeeBlockLegend({ blocks }: EmployeeBlockLegendProps) {
  if (blocks.length === 0) return null;

  return (
    <div className="greenhouse-live-block-legend">
      {blocks.map((block) => {
        const color = employeeBlockColorDef(block.colorKey);
        const employeeName = block.employeeFirstName
          ? `${block.employeeFirstName} ${block.employeeLastName ?? ""}`.trim()
          : "Unassigned";
        return (
          <span key={block.id} className="greenhouse-live-block-legend-item">
            <span
              className="greenhouse-live-legend-swatch"
              style={color ? { background: color.fill, border: `1px solid ${color.stroke}` } : undefined}
            />
            <span className="greenhouse-live-block-legend-text">
              {block.name} — {employeeName}
              <span className="greenhouse-live-block-legend-progress">
                {block.completedRows} / {block.totalRows} rows
              </span>
            </span>
          </span>
        );
      })}
    </div>
  );
}
