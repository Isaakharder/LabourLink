import { useState } from "react";
import { UnknownRowsCode, WeighingPickedRow, WeighingRows } from "../../lib/scaleWeighingTypes";

// Rows a weighed bin was picked in, grouped by phase ("Phase 1 · 12, 13").
// When the server could not tell the bin use apart it says why
// (server/src/lib/scaleWeighingRows.ts); the cell then shows — with a short
// label that is always visible, and a button that reveals the full reason on
// tap, click or keyboard (no hover needed on tablets and touchscreens).

export const UNKNOWN_ROWS_LABELS: Record<UnknownRowsCode, string> = {
  noCycle: "No picking cycle",
  severalInCycle: "Several pickers",
  competing: "Needs review",
  nobody: "No phone scan",
  earlierDay: "Began an earlier day",
  noRows: "No row recorded",
  duplicate: "Duplicate",
};

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

function UnknownRows({ rows }: { rows: Extract<WeighingRows, { status: "unknown" }> | undefined }) {
  const [open, setOpen] = useState(false);
  const label = rows ? UNKNOWN_ROWS_LABELS[rows.code] ?? "Unknown" : "Unknown";
  const reason = rows?.reason || "The rows for this weighing aren't available.";
  return (
    <span className="scale-rows-unknown">
      <button
        type="button"
        className="scale-rows-why"
        aria-expanded={open}
        aria-label={`Rows unknown: ${label}. ${open ? "Hide" : "Show"} why`}
        // The table row opens the weighing; this button only explains.
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <span aria-hidden="true">—</span>
        <span className="scale-rows-why-label">{label}</span>
        <span className="scale-rows-why-icon" aria-hidden="true">
          i
        </span>
      </button>
      {open && (
        <span className="scale-rows-why-text" role="note">
          {reason}
        </span>
      )}
    </span>
  );
}

export function WeighingRowsCell({ rows }: { rows: WeighingRows | undefined }) {
  if (!rows || rows.status === "unknown") return <UnknownRows rows={rows} />;
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

// Full list for the detail dialog; the reason is always written out there.
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
