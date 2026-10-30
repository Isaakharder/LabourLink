import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GreenhouseLiveCanvas } from "../../components/greenhouseLive/GreenhouseLiveCanvas";
import { TvRankingSlide } from "../../components/greenhouseLive/TvRankingSlide";
import { TvRankingHeader } from "../../components/greenhouseLive/TvRankingHeader";
import { graphSpeedUnit } from "../../lib/speedUnitDisplay";
import { api } from "../../lib/api";
import { CanvasTransform, computeFitTransformToPhases } from "../../lib/canvasTransform";
import { buildSlideSequence, formatAge, indexAfterUpdate, isStale, msUntilScheduleCheck, SlideItem } from "../../lib/displaySlideshow";
import { ActivitySlide, DisplaySlidesResponse, GreenhouseDisplayStateResponse } from "../../lib/greenhouseLiveTypes";
import { formatDateLong, formatTimeInAppTimezone } from "../../lib/timezone";

interface GreenhouseDisplayPageProps {
  displayKey: string;
}

const MAP_POLL_MS = 10000;
const SLIDES_POLL_MS = 60000;
const DEFAULT_MAP_SECONDS = 20;

function isNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "status" in err && (err as { status: number }).status === 404);
}

// The break-room TV: full viewport, zero controls, no session. Reads only
// what the office has published (display-key auth, see
// server/src/middleware/displayAuth.ts). A slideshow: the map, plus one
// employee speed-ranking slide per activity sent to this TV that has work
// in the reporting period (GET .../slides) — each only while its Display →
// Setup schedule allows it. With nothing scheduled it says so, and it
// re-checks the moment a schedule starts or ends. Never blanks on a failed
// poll — the last good data stays on screen, labelled with its age.
export function GreenhouseDisplayPage({ displayKey }: GreenhouseDisplayPageProps) {
  const [data, setData] = useState<GreenhouseDisplayStateResponse | null>(null);
  const [mapLastOk, setMapLastOk] = useState<number | null>(null);
  const [mapFailing, setMapFailing] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const [slidesData, setSlidesData] = useState<DisplaySlidesResponse | null>(null);
  const [slidesLastOk, setSlidesLastOk] = useState<number | null>(null);
  const [slidesFailing, setSlidesFailing] = useState(false);

  const [now, setNow] = useState(() => Date.now());

  const [transform, setTransform] = useState<CanvasTransform>({ pan: { x: 0, y: 0 }, scale: 1 });
  const [fitScale, setFitScale] = useState(1);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });

  const loadMap = useCallback(() => {
    api<GreenhouseDisplayStateResponse>(`/api/greenhouse/display/${displayKey}/state`)
      .then((res) => {
        setData(res);
        setMapLastOk(Date.now());
        setMapFailing(false);
        setNotFound(false);
      })
      .catch((err) => {
        // A 404 (bad/deactivated/regenerated link) won't fix itself by
        // retrying soon, but polling continues, so a re-activated display
        // comes back on its own.
        if (isNotFound(err)) setNotFound(true);
        else setMapFailing(true);
      });
  }, [displayKey]);

  const loadSlides = useCallback(() => {
    api<DisplaySlidesResponse>(`/api/greenhouse/display/${displayKey}/slides`, { timeoutMs: 45000 })
      .then((res) => {
        setSlidesData(res);
        setSlidesLastOk(Date.now());
        setSlidesFailing(false);
      })
      .catch((err) => {
        if (isNotFound(err)) setNotFound(true);
        else setSlidesFailing(true);
      });
  }, [displayKey]);

  useEffect(() => {
    loadMap();
    loadSlides();
    const mapTimer = window.setInterval(loadMap, MAP_POLL_MS);
    const slidesTimer = window.setInterval(loadSlides, SLIDES_POLL_MS);
    const clock = window.setInterval(() => setNow(Date.now()), 15000);
    function refreshNow() {
      loadMap();
      loadSlides();
    }
    function onVisibilityChange() {
      if (document.visibilityState === "visible") refreshNow();
    }
    window.addEventListener("focus", refreshNow);
    window.addEventListener("online", refreshNow);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(mapTimer);
      window.clearInterval(slidesTimer);
      window.clearInterval(clock);
      window.removeEventListener("focus", refreshNow);
      window.removeEventListener("online", refreshNow);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [loadMap, loadSlides]);

  // Re-check exactly when a schedule starts or ends, not only on the next
  // regular poll.
  useEffect(() => {
    const wait = msUntilScheduleCheck(slidesData?.nextScheduleChangeAt, Date.now(), SLIDES_POLL_MS);
    if (wait == null) return;
    const timer = window.setTimeout(loadSlides, wait);
    return () => window.clearTimeout(timer);
  }, [slidesData, loadSlides]);

  // --- Slide rotation -------------------------------------------------------
  // Until the first slides response arrives the map shows, as before.
  const sequence = useMemo(
    () => buildSlideSequence(slidesData?.slides, slidesData?.mapSlideSeconds ?? DEFAULT_MAP_SECONDS, slidesData?.mapEnabled ?? true),
    [slidesData]
  );
  const [index, setIndex] = useState(0);
  const currentRef = useRef<SlideItem | undefined>(undefined);
  useEffect(() => {
    setIndex(indexAfterUpdate(currentRef.current, sequence));
  }, [sequence]);
  const current: SlideItem | undefined = sequence[Math.min(index, sequence.length - 1)];
  currentRef.current = current;
  useEffect(() => {
    if (!current || sequence.length <= 1) return; // one slide (or none): no rotation
    const timer = window.setTimeout(() => setIndex((i) => (i + 1) % sequence.length), current.seconds * 1000);
    return () => window.clearTimeout(timer);
  }, [current, sequence.length]);

  // --- Map fitting (unchanged behaviour) ------------------------------------
  // Refit whenever the viewport resizes, and whenever a publish changes the
  // config (configVersion) — but not on routine polls, which would reset the
  // view every 10 seconds.
  useEffect(() => {
    if (!data || viewportSize.width <= 0 || viewportSize.height <= 0) return;
    const fit = computeFitTransformToPhases(data.land, data.land.phases, viewportSize.width, viewportSize.height, data.rotationDegrees);
    setFitScale(fit.scale);
    setTransform(fit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewportSize.width, viewportSize.height, data?.configVersion]);

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

  const mapStale = mapFailing || isStale(mapLastOk, now, MAP_POLL_MS);
  const slidesStale = slidesFailing && slidesLastOk !== null;
  const onActivity = current?.kind === "activity";
  const nothingScheduled = sequence.length === 0;

  const dots =
    sequence.length > 1 ? (
      <div className="tv-slide-dots" aria-hidden="true">
        {sequence.map((item, i) => (
          <span key={item.key} className={`tv-slide-dot${i === index ? " active" : ""}`} />
        ))}
      </div>
    ) : null;
  const slidesStatus = slidesStale ? (
    <span className="status-pill greenhouse-tv-stale-badge">
      Reconnecting… Rankings from {formatTimeInAppTimezone(new Date(slidesLastOk!).toISOString(), { seconds: false })} ({formatAge(now - slidesLastOk!)} old)
    </span>
  ) : (
    slidesData && <span className="greenhouse-tv-updated">Updated {formatTimeInAppTimezone(slidesData.generatedAt, { seconds: false })}</span>
  );

  return (
    <div className="greenhouse-tv-page">
      {onActivity ? (
        // Every activity ranking slide shares this compact header.
        <TvRankingHeader
          displayName={data?.name ?? "LabourLink"}
          slide={current.slide}
          week={slidesData?.period.week ?? null}
          status={slidesStatus}
          dots={dots}
        />
      ) : (
        <div className="greenhouse-tv-header">
          <div className="greenhouse-tv-title">
            <h1>{data?.name ?? "LabourLink"}</h1>
          </div>
          <div className="greenhouse-tv-header-center">
            {!nothingScheduled && data && (
              <>
                <p className="greenhouse-tv-activity">{data.activityName ?? "All jobs"}</p>
                <p className="greenhouse-tv-daterange">{rangeLabel}</p>
              </>
            )}
          </div>
          <div className="greenhouse-tv-status">
            {nothingScheduled ? (
              slidesStatus
            ) : mapStale && mapLastOk !== null ? (
              <span className="status-pill greenhouse-tv-stale-badge">
                Reconnecting… Map from {formatTimeInAppTimezone(new Date(mapLastOk).toISOString())} ({formatAge(now - mapLastOk)} old)
              </span>
            ) : mapStale ? (
              <span className="status-pill greenhouse-tv-stale-badge">Reconnecting…</span>
            ) : (
              data && <span className="greenhouse-tv-updated">Updated {formatTimeInAppTimezone(data.generatedAt)}</span>
            )}
            {dots}
          </div>
        </div>
      )}

      <div className="greenhouse-tv-canvas-wrapper">
        {/* The map stays mounted under the ranking slides so it never has
            to re-measure or refit when the slideshow returns to it. */}
        {data ? (
          <GreenhouseLiveCanvas
            land={data.land}
            phases={data.land.phases}
            phaseFilterId={null}
            transform={transform}
            onTransformChange={setTransform}
            onViewportSize={setViewportSize}
            minScale={fitScale * 0.15}
            maxScale={fitScale * 6}
            rotationDegrees={data.rotationDegrees}
            interactive={false}
            blocks={data.blocks}
          />
        ) : (
          <p className="placeholder-page greenhouse-tv-loading">{mapFailing ? "Map unavailable — retrying…" : "Loading…"}</p>
        )}
        {current?.kind === "activity" && (
          <div className="tv-slide-overlay">
            <TvRankingSlide item={current} />
          </div>
        )}
        {nothingScheduled && (
          <div className="tv-slide-overlay tv-nothing-scheduled" role="status">
            <p>No slides scheduled right now</p>
          </div>
        )}
      </div>

      {/* Work-status legend only. The TV deliberately has no block-name /
          assigned-employee legend (or labels): blocks are shown by their
          outlines, and who is working where by the live employee cards. */}
      {current?.kind === "map" && (
        <div className="greenhouse-tv-legend">
          <span>
            <span className="greenhouse-live-legend-swatch greenhouse-live-row-blue" /> Currently working
          </span>
          <span>
            <span className="greenhouse-live-legend-swatch greenhouse-live-row-green" /> Completed Row
          </span>
          <span>
            <span className="greenhouse-live-legend-swatch greenhouse-live-row-neutral" /> No activity
          </span>
        </div>
      )}
    </div>
  );
}
