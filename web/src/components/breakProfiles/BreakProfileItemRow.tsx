import { BreakProfileItemDraft } from "../../lib/breakProfileTypes";

interface BreakProfileItemRowProps {
  item: BreakProfileItemDraft;
  isFirst: boolean;
  isLast: boolean;
  onChange: (patch: Partial<BreakProfileItemDraft>) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

// "15 minutes" / "1 hour" / "1 hour 30 minutes" style, or null when the row
// doesn't have a valid start/end yet.
function durationLabel(startTime: string, endTime: string): string | null {
  if (!startTime || !endTime) return null;
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  const diff = eh * 60 + em - (sh * 60 + sm);
  if (diff <= 0) return null;
  const hours = Math.floor(diff / 60);
  const mins = diff % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (mins > 0) parts.push(`${mins} minute${mins === 1 ? "" : "s"}`);
  return parts.join(" ");
}

export function BreakProfileItemRow({
  item,
  isFirst,
  isLast,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: BreakProfileItemRowProps) {
  const duration = durationLabel(item.startTime, item.endTime);

  return (
    <div className="break-item-row">
      <div className="break-item-row-order">
        <button type="button" onClick={onMoveUp} disabled={isFirst} aria-label="Move break earlier">
          ↑
        </button>
        <button type="button" onClick={onMoveDown} disabled={isLast} aria-label="Move break later">
          ↓
        </button>
      </div>

      <div className="break-item-row-fields">
        <label>
          Break name (optional)
          <input
            type="text"
            placeholder="e.g. Morning Break"
            value={item.name}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </label>

        <label>
          Start Time
          <input type="time" value={item.startTime} onChange={(e) => onChange({ startTime: e.target.value })} />
        </label>

        <label>
          End Time
          <input type="time" value={item.endTime} onChange={(e) => onChange({ endTime: e.target.value })} />
        </label>

        <label>
          Paid / Unpaid
          <select
            value={item.isPaid ? "paid" : "unpaid"}
            onChange={(e) => onChange({ isPaid: e.target.value === "paid" })}
          >
            <option value="unpaid">Unpaid</option>
            <option value="paid">Paid</option>
          </select>
        </label>

        <div className="break-item-row-duration">{duration ?? "—"}</div>
      </div>

      <div className="break-item-row-toggles">
        <div className="break-item-toggle-group">
          <label className="break-item-toggle">
            <input
              type="checkbox"
              checked={item.fixedBreak}
              onChange={(e) => onChange({ fixedBreak: e.target.checked })}
            />
            Fixed Break
          </label>
          <p className="field-hint">
            The configured start and end time are the authoritative record — an employee's tap only confirms the
            scheduled break happened, it never changes the recorded times. Example: a Lunch Break scheduled 12:00
            PM–1:00 PM records exactly 12:00 PM–1:00 PM no matter when the employee taps, as long as each tap falls
            somewhere inside that window — Start Break anytime between 12:00 PM and 1:00 PM records 12:00 PM, and End
            Break anytime after that records 1:00 PM. A tap at 12:02 PM and another at 12:58 PM still produce
            12:00 PM–1:00 PM.
          </p>
        </div>

        <div className="break-item-toggle-group">
          <label className="break-item-toggle">
            <input
              type="checkbox"
              checked={item.autoAdd}
              onChange={(e) => onChange({ autoAdd: e.target.checked })}
            />
            Auto Add
          </label>
          <p className="field-hint">
            If the employee works through this scheduled break without pressing Break, LabourLink automatically adds
            the break to their day.
          </p>
        </div>
      </div>

      <button type="button" className="break-item-row-remove" onClick={onRemove} aria-label="Remove scheduled break">
        Remove
      </button>
    </div>
  );
}
