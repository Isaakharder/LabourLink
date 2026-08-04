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
  generatedAt,
  refreshing,
  onRefresh,
}: GreenhouseLiveToolbarProps) {
  return (
    <div className="greenhouse-toolbar">
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
        <select
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
      </div>

      <div className="greenhouse-toolbar-spacer" />

      <div className="greenhouse-toolbar-group">
        {generatedAt && (
          <span className="greenhouse-live-updated">Last updated {formatTimeInAppTimezone(generatedAt)}</span>
        )}
        <button type="button" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
    </div>
  );
}
