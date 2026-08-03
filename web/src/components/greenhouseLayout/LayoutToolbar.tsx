import { ScaleLegend } from "./ScaleLegend";

interface LayoutToolbarProps {
  onBack: () => void;
  sidebarHidden: boolean;
  onToggleSidebar: () => void;
  zoomPercent: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitToScreen: () => void;
  snapEnabled: boolean;
  onSnapToggle: (v: boolean) => void;
  preventOverlap: boolean;
  onPreventOverlapToggle: (v: boolean) => void;
  editMode: boolean;
  onToggleEditMode: () => void;
  hasDraftChanges: boolean;
  // True when preventOverlap is on and the current draft has an overlap —
  // Save Layout is disabled in that case rather than just showing a
  // warning banner elsewhere, which is the whole point of the toggle.
  overlapBlocked: boolean;
  onSaveLayout: () => void;
  onCancelChanges: () => void;
  saving: boolean;
  pxPerFoot: number | null;
  gridFeet: number;
  liveCoordinates: string | null;
}

export function LayoutToolbar({
  onBack,
  sidebarHidden,
  onToggleSidebar,
  zoomPercent,
  onZoomIn,
  onZoomOut,
  onFitToScreen,
  snapEnabled,
  onSnapToggle,
  preventOverlap,
  onPreventOverlapToggle,
  editMode,
  onToggleEditMode,
  hasDraftChanges,
  overlapBlocked,
  onSaveLayout,
  onCancelChanges,
  saving,
  pxPerFoot,
  gridFeet,
  liveCoordinates,
}: LayoutToolbarProps) {
  return (
    <div className="greenhouse-toolbar">
      <div className="greenhouse-toolbar-group">
        <button type="button" onClick={onBack}>
          ← Back
        </button>
        <button type="button" onClick={onToggleSidebar}>
          {sidebarHidden ? "Show navigation" : "Hide navigation"}
        </button>
      </div>

      <div className="greenhouse-toolbar-divider" />

      <div className="greenhouse-toolbar-group">
        <button type="button" onClick={onZoomOut} aria-label="Zoom out">
          −
        </button>
        <span className="greenhouse-zoom-level">{zoomPercent}%</span>
        <button type="button" onClick={onZoomIn} aria-label="Zoom in">
          +
        </button>
        <button type="button" onClick={onFitToScreen}>
          Fit to screen
        </button>
      </div>

      <div className="greenhouse-toolbar-divider" />

      <div className="greenhouse-toolbar-group">
        <label className="greenhouse-toolbar-checkbox">
          <input type="checkbox" checked={snapEnabled} onChange={(e) => onSnapToggle(e.target.checked)} />
          Snap to grid
        </label>
        <label className="greenhouse-toolbar-checkbox">
          <input
            type="checkbox"
            checked={preventOverlap}
            onChange={(e) => onPreventOverlapToggle(e.target.checked)}
          />
          Prevent overlap
        </label>
      </div>

      <div className="greenhouse-toolbar-divider" />

      <div className="greenhouse-toolbar-group">
        <button type="button" className={editMode ? "greenhouse-edit-mode-active" : ""} onClick={onToggleEditMode}>
          {editMode ? "Exit Edit Phases" : "Edit Phases"}
        </button>
        {editMode && (
          <>
            <button
              type="button"
              className="employees-add-button"
              onClick={onSaveLayout}
              disabled={!hasDraftChanges || saving || overlapBlocked}
              title={overlapBlocked ? "Resolve overlapping phases before saving, or turn off Prevent overlap" : undefined}
            >
              {saving ? "Saving..." : "Save Layout"}
            </button>
            <button type="button" onClick={onCancelChanges} disabled={!hasDraftChanges || saving}>
              Cancel Changes
            </button>
          </>
        )}
      </div>

      {liveCoordinates && <div className="greenhouse-live-coordinates">{liveCoordinates}</div>}

      <div className="greenhouse-toolbar-spacer" />
      <ScaleLegend pxPerFoot={pxPerFoot} gridFeet={gridFeet} />
    </div>
  );
}
