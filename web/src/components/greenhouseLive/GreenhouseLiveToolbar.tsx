import { Maximize, Minus, Plus, RotateCw } from "lucide-react";
import { formatTimeInAppTimezone } from "../../lib/timezone";

// Phase selection moved out of this toolbar into Display → Map's sidebar as
// published per-display checkboxes (GreenhousePage.tsx).
interface GreenhouseLiveToolbarProps {
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
