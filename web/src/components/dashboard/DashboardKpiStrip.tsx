import { Link } from "react-router-dom";
import { GetDashboardKpisResponse, KgWeighedKpi } from "../../lib/dashboardTypes";
import { formatTimeInAppTimezone } from "../../lib/timezone";

// A row of small greenhouse-wide figures at the top of the Dashboard. The
// strip is a wrapping grid of fixed-width tiles, so more KPI cards can be
// added later without stretching or crowding the ones already there. A KPI
// that doesn't apply to this greenhouse (null from the server) has no tile,
// and with no tiles at all the strip isn't rendered.

const kgFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

export function formatKg(kg: number): string {
  return `${kgFormat.format(kg)} kg`;
}

function KgWeighedTodayCard({ kpi }: { kpi: KgWeighedKpi }) {
  const empty = kpi.bins === 0;
  return (
    <Link to="/scale-weighings" className={`dashboard-kpi-card${empty ? " is-empty" : ""}`} aria-label={`KG weighed today: ${empty ? "no bins weighed yet" : formatKg(kpi.netKg)}. Open Scale Weighings`}>
      <span className="dashboard-kpi-label">KG weighed today</span>
      <span className="dashboard-kpi-value">{empty ? "0 kg" : formatKg(kpi.netKg)}</span>
      <span className="dashboard-kpi-detail">
        {empty
          ? "No bins weighed yet today"
          : `${kpi.bins} bin${kpi.bins === 1 ? "" : "s"}${kpi.lastWeighedAt ? ` · last ${formatTimeInAppTimezone(kpi.lastWeighedAt, { seconds: false })}` : ""}`}
      </span>
    </Link>
  );
}

export function DashboardKpiStrip({ kpis }: { kpis: GetDashboardKpisResponse | null }) {
  if (!kpis) return null;
  const tiles = [kpis.kgWeighedToday && <KgWeighedTodayCard key="kg" kpi={kpis.kgWeighedToday} />].filter(Boolean);
  if (tiles.length === 0) return null;
  return (
    <section className="dashboard-kpi-strip" aria-label="Today at a glance">
      {tiles}
    </section>
  );
}
