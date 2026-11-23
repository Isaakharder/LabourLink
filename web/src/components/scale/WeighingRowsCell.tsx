import { WeighingPickedRow, WeighingRows } from "../../lib/scaleWeighingTypes";

// Rows a weighed bin was picked in, grouped by phase ("Phase 1 · 12, 13").
// Unknown rows show — with the reason as a tooltip and accessible name; the
// server already refused to guess (server/src/lib/scaleWeighingRows.ts).

export function groupRowsByPhase(rows: WeighingPickedRow[]): { phase: string; numbers: number[] }[] {
  const groups: { phase: string; numbers: number[] }[] = [];
  for (const r of rows) {
    const g = groups.find((x) => x.phase === r.phaseName);
    if (g) g.numbers.push(r.rowNumber);
    else groups.push({ phase: r.phaseName, numbers: [r.rowNumber] });
  }
  return groups;
}

const MAX_GROUPS = 2;
const MAX_NUMBERS = 4;

export function WeighingRowsCell({ rows }: { rows: WeighingRows | undefined }) {
  if (!rows || rows.status === "unknown") {
    const reason = rows?.status === "unknown" ? rows.reason : "Rows not available";
    return (
      <span className="scale-rows-unknown" title={reason} aria-label={`Rows unknown: ${reason}`}>
        —
      </span>
    );
  }
  const groups = groupRowsByPhase(rows.rows);
  const full = rows.rows.map((r) => r.label).join(", ");
  const shown = groups.slice(0, MAX_GROUPS);
  const hiddenCount = groups.slice(MAX_GROUPS).reduce((n, g) => n + g.numbers.length, 0) + shown.reduce((n, g) => n + Math.max(0, g.numbers.length - MAX_NUMBERS), 0);
  return (
    <span className="scale-rows" title={full} aria-label={`Rows: ${full}`}>
      {shown.map((g) => (
        <span key={g.phase} className="scale-rows-group">
          <span className="scale-rows-phase">{g.phase}</span>
          <span className="scale-rows-numbers">{g.numbers.slice(0, MAX_NUMBERS).join(", ")}</span>
        </span>
      ))}
      {hiddenCount > 0 && <span className="scale-rows-more">+{hiddenCount} more</span>}
    </span>
  );
}

// Full list for the detail dialog.
export function WeighingRowsList({ rows }: { rows: WeighingRows | undefined }) {
  if (!rows || rows.status === "unknown") {
    return (
      <>
        —{rows?.status === "unknown" && <div className="field-hint">{rows.reason}</div>}
      </>
    );
  }
  return (
    <span className="scale-rows scale-rows-full">
      {groupRowsByPhase(rows.rows).map((g) => (
        <span key={g.phase} className="scale-rows-group">
          <span className="scale-rows-phase">{g.phase}</span>
          <span className="scale-rows-numbers">
            {g.numbers.length === 1 ? "Row" : "Rows"} {g.numbers.join(", ")}
          </span>
        </span>
      ))}
    </span>
  );
}
