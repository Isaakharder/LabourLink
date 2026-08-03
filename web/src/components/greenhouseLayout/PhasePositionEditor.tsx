import { MouseEvent as ReactMouseEvent } from "react";
import { GreenhouseLand, GreenhousePhase } from "../../lib/greenhouseLayoutTypes";

const STEP_OPTIONS = [1, 5, 10, 25];
const SHIFT_STEP_FEET = 10;
// Tolerance for floating-point drift when comparing a phase's edge against
// the land boundary (e.g. after a proportional rescale) — without this, an
// edge that's boundary-equal but off by a fraction of a foot would leave a
// D-pad direction wrongly enabled/disabled.
const EPSILON = 0.001;

interface PhasePositionEditorProps {
  phase: GreenhousePhase;
  land: GreenhouseLand;
  moveStep: number;
  onStepChange: (step: number) => void;
  onMove: (dxDirection: -1 | 0 | 1, dyDirection: -1 | 0 | 1, step: number) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  saveError: string | null;
}

export function PhasePositionEditor({
  phase,
  land,
  moveStep,
  onStepChange,
  onMove,
  onSave,
  onCancel,
  saving,
  saveError,
}: PhasePositionEditorProps) {
  const atWest = phase.xFeetFromWest <= EPSILON;
  const atEast = phase.xFeetFromWest + phase.eastWestFeet >= land.eastWestFeet - EPSILON;
  const atNorth = phase.yFeetFromNorth <= EPSILON;
  const atSouth = phase.yFeetFromNorth + phase.northSouthFeet >= land.northSouthFeet - EPSILON;

  function move(dx: -1 | 0 | 1, dy: -1 | 0 | 1, e: ReactMouseEvent) {
    onMove(dx, dy, e.shiftKey ? SHIFT_STEP_FEET : moveStep);
  }

  return (
    <div className="greenhouse-position-editor">
      <h4>Edit Position — {phase.name}</h4>

      <div className="greenhouse-step-selector">
        <span>Step</span>
        {STEP_OPTIONS.map((s) => (
          <button
            key={s}
            type="button"
            className={s === moveStep ? "greenhouse-step-active" : ""}
            onClick={() => onStepChange(s)}
          >
            {s} ft
          </button>
        ))}
      </div>

      <div className="greenhouse-dpad">
        <button
          type="button"
          className="greenhouse-dpad-up"
          disabled={atNorth}
          onClick={(e) => move(0, -1, e)}
          aria-label="Move phase up (north)"
        >
          ↑
        </button>
        <button
          type="button"
          className="greenhouse-dpad-left"
          disabled={atWest}
          onClick={(e) => move(-1, 0, e)}
          aria-label="Move phase left (west)"
        >
          ←
        </button>
        <button
          type="button"
          className="greenhouse-dpad-right"
          disabled={atEast}
          onClick={(e) => move(1, 0, e)}
          aria-label="Move phase right (east)"
        >
          →
        </button>
        <button
          type="button"
          className="greenhouse-dpad-down"
          disabled={atSouth}
          onClick={(e) => move(0, 1, e)}
          aria-label="Move phase down (south)"
        >
          ↓
        </button>
      </div>

      <div className="greenhouse-position-coords">
        <div>West offset: {Math.round(phase.xFeetFromWest * 10) / 10} ft</div>
        <div>North offset: {Math.round(phase.yFeetFromNorth * 10) / 10} ft</div>
      </div>

      {saveError && <p className="error-text">{saveError}</p>}

      <div className="greenhouse-position-editor-actions">
        <button type="button" className="employees-add-button" onClick={onSave} disabled={saving}>
          {saving ? "Saving..." : "Save Position"}
        </button>
        <button type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </div>
  );
}
