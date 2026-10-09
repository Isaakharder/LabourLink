import { formatSpeed, SlideItem } from "../../lib/displaySlideshow";

interface TvRankingSlideProps {
  item: Extract<SlideItem, { kind: "activity" }>;
}

// One employee speed-ranking slide on the break-room TV. Sized for reading
// across a room at 1920×1080: at most ROWS_PER_PAGE rows, large names and
// values. Speeds come straight from the server's canonical calculation —
// this only lays them out; it never fills in a missing speed.
export function TvRankingSlide({ item }: TvRankingSlideProps) {
  const { slide, employees, firstRank, page, pageCount } = item;
  const unit = slide.speedUnit ?? "";

  if (slide.status !== "ok") {
    return (
      <div className={`tv-ranking tv-ranking-notice-only ${slide.status === "unavailable" ? "tv-ranking-unavailable" : ""}`}>
        <p className="tv-ranking-notice-title">
          {slide.status === "unavailable"
            ? "Unavailable"
            : slide.reason === "no_density"
              ? "No speed ranking"
              : slide.reason === "below_minimum"
                ? "No one listed yet"
                : "No speeds yet"}
        </p>
        <p className="tv-ranking-notice-text">{slide.notice}</p>
      </div>
    );
  }

  const maxSpeed = Math.max(...slide.employees.map((e) => e.speed), slide.target ?? 0, 1);
  const scale = maxSpeed * 1.08;
  const targetPct = slide.target ? (slide.target / scale) * 100 : null;

  const footnotes: string[] = [];
  if (slide.belowMinimumHours > 0) {
    footnotes.push(`${slide.belowMinimumHours} under the ${slide.minimumActivityHours} h minimum not shown`);
  }
  if (slide.employeesWithoutSpeed > 0) {
    footnotes.push(`${slide.employeesWithoutSpeed} without a calculable speed yet`);
  }
  if (slide.topN) footnotes.push(`Top ${slide.topN}`);

  return (
    <div className="tv-ranking">
      <ol className="tv-ranking-list" start={firstRank}>
        {employees.map((e, i) => {
          const pct = (e.speed / scale) * 100;
          const meetsTarget = slide.target != null && e.speed >= slide.target;
          return (
            <li key={`${firstRank + i}:${e.firstName}${e.lastInitial}`} className="tv-ranking-row">
              <span className="tv-ranking-rank">{firstRank + i}</span>
              <span className="tv-ranking-name">
                {e.firstName} {e.lastInitial}
              </span>
              <span className="tv-ranking-bar-track">
                <span className={`tv-ranking-bar${meetsTarget ? " tv-ranking-bar-target-met" : ""}`} style={{ width: `${pct}%` }} />
                {targetPct != null && <span className="tv-ranking-target-line" style={{ left: `${targetPct}%` }} />}
              </span>
              <span className="tv-ranking-value">
                {formatSpeed(e.speed)}
                <span className="tv-ranking-hours">{e.activityHours.toFixed(1)} h</span>
              </span>
            </li>
          );
        })}
      </ol>
      <div className="tv-ranking-footer">
        <span>
          {slide.target != null && (
            <>
              <span className="tv-ranking-target-key" /> Target {formatSpeed(slide.target)} {unit}
            </>
          )}
        </span>
        <span className="tv-ranking-footnotes">{footnotes.join(" · ")}</span>
        <span>{pageCount > 1 ? `Page ${page} of ${pageCount}` : ""}</span>
      </div>
    </div>
  );
}
