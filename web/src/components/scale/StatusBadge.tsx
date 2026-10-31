import { ScaleWeighingRow, STATUS_LABELS } from "../../lib/scaleWeighingTypes";

// A weighing's status, plus "Duplicate" (not counted) and "Trial" (credits
// were off at the station, so never an employee credit).
export function StatusBadge({ row }: { row: Pick<ScaleWeighingRow, "status" | "creditsLive" | "isDuplicate"> }) {
  return (
    <span className="scale-weighing-status">
      <span className={`scale-status scale-status-${row.status}`}>{STATUS_LABELS[row.status]}</span>
      {row.isDuplicate && <span className="scale-status scale-status-note">Duplicate</span>}
      {!row.creditsLive && <span className="scale-status scale-status-note">Trial</span>}
    </span>
  );
}
