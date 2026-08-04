import { useCallback, useEffect, useState } from "react";
import { GreenhouseLiveCanvas } from "../../components/greenhouseLive/GreenhouseLiveCanvas";
import { api } from "../../lib/api";
import { CanvasTransform, computeFitTransform } from "../../lib/canvasTransform";
import { GreenhouseDisplayStateResponse } from "../../lib/greenhouseLiveTypes";
import { formatDateLong, formatTimeInAppTimezone } from "../../lib/timezone";

interface GreenhouseDisplayPageProps {
  displayKey: string;
}

const POLL_INTERVAL_MS = 10000;

// The break-room TV: full viewport, zero controls, no session. Reads only
// what the office page has published (see greenhouseDisplays.ts / the
// requireDisplayKey-authed /display/:displayKey/state route) and never
// blanks on a failed poll — the last successfully rendered map stays on
// screen with a small stale indicator instead.
export function GreenhouseDisplayPage({ displayKey }: GreenhouseDisplayPageProps) {
  const [data, setData] = useState<GreenhouseDisplayStateResponse | null>(null);
  const [stale, setStale] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const [transform, setTransform] = useState<CanvasTransform>({ pan: { x: 0, y: 0 }, scale: 1 });
  const [fitScale, setFitScale] = useState(1);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });

  const load = useCallback(() => {
    api<GreenhouseDisplayStateResponse>(`/api/greenhouse/display/${displayKey}/state`)
      .then((res) => {
        setData(res);
        setStale(false);
        setNotFound(false);
      })
      .catch((err) => {
        // A 404 (bad/deactivated/regenerated token) is not a transient
        // failure — no retry will ever fix it, so it gets its own terminal
        // message rather than the "stale, still retrying" indicator.
        if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 404) {
          setNotFound(true);
          return;
        }
        setStale(true);
      });
  }, [displayKey]);

  useEffect(() => {
    load();
    const interval = window.setInterval(load, POLL_INTERVAL_MS);
    function onFocus() {
      load();
    }
    function onVisibilityChange() {
      if (document.visibilityState === "visible") load();
    }
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [load]);

  // Refit whenever the viewport itself resizes (the TV's own window/canvas
  // dimensions changed) — always, since there's no user pan/zoom state on a
  // control-free display worth preserving across a resize.
  useEffect(() => {
    if (!data || viewportSize.width <= 0 || viewportSize.height <= 0) return;
    const fit = computeFitTransform(data.land, viewportSize.width, viewportSize.height);
    setFitScale(fit.scale);
    setTransform(fit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewportSize.width, viewportSize.height]);

  // Also refit whenever a fresh publish changes the config (land/date/
  // activity scope may have changed) — but not on every routine poll where
  // nothing actually changed, which would otherwise flash/reset the view
  // roughly every 10 seconds for no reason.
  useEffect(() => {
    if (!data || viewportSize.width <= 0 || viewportSize.height <= 0) return;
    const fit = computeFitTransform(data.land, viewportSize.width, viewportSize.height);
    setFitScale(fit.scale);
    setTransform(fit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.configVersion]);

  function handleViewportSize(size: { width: number; height: number }) {
    setViewportSize(size);
  }

  const rangeLabel = data
    ? data.dateStart === data.dateEnd
      ? formatDateLong(data.dateStart)
      : `${formatDateLong(data.dateStart)} – ${formatDateLong(data.dateEnd)}`
    : "";

  if (notFound) {
    return (
      <div className="greenhouse-tv-page greenhouse-tv-page-error">
        <p>This display link is no longer active.</p>
      </div>
    );
  }

  return (
    <div className="greenhouse-tv-page">
      <div className="greenhouse-tv-header">
        <div className="greenhouse-tv-title">
          <h1>{data?.name ?? "Greenhouse"}</h1>
          {data && (
            <p className="greenhouse-tv-subtitle">
              {data.activityName ?? "All activities"} · {rangeLabel}
            </p>
          )}
        </div>
        <div className="greenhouse-tv-status">
          {stale && <span className="status-pill greenhouse-tv-stale-badge">Reconnecting…</span>}
          {data && !stale && (
            <span className="greenhouse-tv-updated">Updated {formatTimeInAppTimezone(data.generatedAt)}</span>
          )}
        </div>
      </div>

      <div className="greenhouse-tv-canvas-wrapper">
        {data ? (
          <GreenhouseLiveCanvas
            land={data.land}
            phases={data.land.phases}
            phaseFilterId={null}
            transform={transform}
            onTransformChange={setTransform}
            onViewportSize={handleViewportSize}
            minScale={fitScale * 0.15}
            maxScale={fitScale * 6}
          />
        ) : (
          <p className="placeholder-page greenhouse-tv-loading">Loading…</p>
        )}
      </div>

      <div className="greenhouse-tv-legend">
        <span>
          <span className="greenhouse-live-legend-swatch greenhouse-live-row-blue" /> Currently working
        </span>
        <span>
          <span className="greenhouse-live-legend-swatch greenhouse-live-row-green" /> Completed in selected range
        </span>
        <span>
          <span className="greenhouse-live-legend-swatch greenhouse-live-row-neutral" /> No matching work
        </span>
      </div>
    </div>
  );
}
