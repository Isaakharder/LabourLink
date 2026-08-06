import { Maximize, Minus, Plus, RotateCw } from "lucide-react";
import { LivePhase } from "../../lib/greenhouseLiveTypes";
import { formatTimeInAppTimezone } from "../../lib/timezone";

interface GreenhouseLiveToolbarProps {
  phases: LivePhase[];
  phaseFilterId: string | null;
  onPhaseFilterChange: (id: string | null) => void;
  zoomPercent: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitToScreen: () => void;
  onRotate: () => void;
  generatedAt: string | null;
  refreshing: boolean;
  onRefresh: () => void;
}

// View-only toolbar — no snap/edit-mode/save controls the layout editor's
// LayoutToolbar.tsx has, matching the same button styling conventions.
export function GreenhouseLiveToolbar({
  phases,
  phaseFilterId,
  onPhaseFilterChange,
  zoomPercent,
  onZoomIn,
  onZoomOut,
  onFitToScreen,
  onRotate,
  generatedAt,
  refreshing,
  onRefresh,
}: GreenhouseLiveToolbarProps) {
  return (
    <div className="greenhouse-toolbar greenhouse-live-toolbar">
      <div className="greenhouse-toolbar-group greenhouse-live-toolbar-group greenhouse-live-toolbar-zoom">
        <button type="button" className="greenhouse-toolbar-button greenhouse-toolbar-button-icon" onClick={onZoomOut} aria-label="Zoom out">
          <Minus size={16} aria-hidden="true" />
        </button>
        <span className="greenhouse-zoom-level greenhouse-live-zoom-level">{zoomPercent}%</span>
        <button type="button" className="greenhouse-toolbar-button greenhouse-toolbar-button-icon" onClick={onZoomIn} aria-label="Zoom in">
          <Plus size={16} aria-hidden="true" />
        </button>
        <button type="button" className="greenhouse-toolbar-button greenhouse-live-fit-button" onClick={onFitToScreen}>
          <Maximize size={16} aria-hidden="true" />
          <span>Fit to screen</span>
        </button>
        <button
          type="button"
          className="greenhouse-toolbar-button greenhouse-toolbar-button-icon"
          onClick={onRotate}
          aria-label="Rotate map 90° clockwise"
          title="Rotate map 90° clockwise"
        >
          <RotateCw size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="greenhouse-toolbar-divider greenhouse-live-toolbar-divider" />

      <div className="greenhouse-toolbar-group greenhouse-live-toolbar-group greenhouse-live-toolbar-filter-group">
        <label className="greenhouse-live-toolbar-field">
          <span>Phase</span>
          <span className="greenhouse-office-select-wrap greenhouse-live-toolbar-select-wrap">
            <select
              className="greenhouse-office-select greenhouse-live-toolbar-select"
              value={phaseFilterId ?? ""}
              onChange={(e) => onPhaseFilterChange(e.target.value || null)}
              aria-label="Filter by phase"
            >
              <option value="">All phases</option>
              {phases.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </span>
        </label>
      </div>

      <div className="greenhouse-toolbar-spacer" />

      <div className="greenhouse-toolbar-group greenhouse-live-toolbar-group greenhouse-live-toolbar-status-group">
        {generatedAt && (
          <span className="greenhouse-live-updated">Last updated {formatTimeInAppTimezone(generatedAt)}</span>
        )}
        <button type="button" className="greenhouse-toolbar-button" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
    </div>
  );
}
