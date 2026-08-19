import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useWorkSession } from "../../context/WorkSessionContext";
import { api, ApiError } from "../../lib/api";
import { Avatar } from "../../components/employees/Avatar";
import { ActivityTimer } from "../../components/mobile/ActivityTimer";
import { formatSpeedValue } from "../../lib/reportTypes";
import { LiveEmployeeCard, LiveEmployeesResponse } from "../../lib/mobileEmployeesTypes";

// Background refresh cadence — same event-driven-plus-interval convention
// GreenhousePage.tsx's live map uses: a timed poll, plus an immediate
// refresh on window focus and on the tab becoming visible again, so the
// screen never shows stale data after being backgrounded.
const REFRESH_INTERVAL_MS = 30_000;
// A downward drag past this many px, starting from the very top of the
// scrolled list, counts as a pull-to-refresh gesture.
const PULL_TO_REFRESH_THRESHOLD_PX = 70;

type StatusFilter = "all" | "working" | "on_break";

function statusLabel(status: LiveEmployeeCard["status"]): string {
  return status === "working" ? "Working" : "On break";
}

function speedLabel(card: LiveEmployeeCard): string {
  if (card.speedState === "no_metric") return "No speed metric";
  if (card.speedState === "not_enough_data" || card.speedValue == null) return "Not enough data";
  return formatSpeedValue(card.speedValue, card.speedUnit);
}

// A row and a carrier/bin can both be set on the same currently-open entry
// at once (e.g. a density-tracked activity whose picked produce also goes
// into a bin) — locationType only marks which one is the "primary" location
// for the missing-location empty-state check, it was never meant to hide
// whichever field it isn't. Every non-null field is always shown.
function locationLines(card: LiveEmployeeCard): string[] {
  const lines: string[] = [];
  if (card.rowLabel) lines.push(card.rowLabel);
  if (card.carrierName) lines.push(`Carrier: ${card.carrierName}`);
  return lines;
}

export function EmployeesScreen() {
  const { me, handleApiError } = useWorkSession();
  const canView = me?.employee.securityRole === "Administrator" || me?.employee.securityRole === "Manager";

  const [data, setData] = useState<LiveEmployeesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [activityFilter, setActivityFilter] = useState<string>("all");
  const [pulling, setPulling] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const touchStartY = useRef<number | null>(null);

  const load = useCallback(
    (background: boolean) => {
      if (background) setRefreshing(true);
      api<LiveEmployeesResponse>("/api/mobile/employees/live")
        .then((res) => {
          setData(res);
          setError(null);
          setForbidden(false);
        })
        .catch((err) => {
          if (handleApiError(err)) return;
          if (err instanceof ApiError && err.status === 403) {
            setForbidden(true);
          } else {
            setError(err instanceof ApiError ? err.message : "Could not load employees.");
          }
        })
        .finally(() => {
          setLoading(false);
          setRefreshing(false);
        });
    },
    [handleApiError]
  );

  useEffect(() => {
    if (!canView) return;
    load(false);
  }, [canView, load]);

  useEffect(() => {
    if (!canView) return;
    const interval = window.setInterval(() => load(true), REFRESH_INTERVAL_MS);
    const onFocus = () => load(true);
    const onVisibility = () => {
      if (document.visibilityState === "visible") load(true);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [canView, load]);

  function handleTouchStart(e: React.TouchEvent) {
    if ((listRef.current?.scrollTop ?? 0) > 0) {
      touchStartY.current = null;
      return;
    }
    touchStartY.current = e.touches[0].clientY;
  }
  function handleTouchMove(e: React.TouchEvent) {
    if (touchStartY.current == null) return;
    const delta = e.touches[0].clientY - touchStartY.current;
    setPulling(delta > PULL_TO_REFRESH_THRESHOLD_PX);
  }
  function handleTouchEnd() {
    if (pulling) load(true);
    setPulling(false);
    touchStartY.current = null;
  }

  const activityOptions = useMemo(() => {
    const names = new Set<string>();
    for (const e of data?.employees ?? []) {
      if (e.activityName) names.add(e.activityName);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [data]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (data?.employees ?? []).filter((e) => {
      if (statusFilter !== "all" && e.status !== statusFilter) return false;
      if (activityFilter !== "all" && e.activityName !== activityFilter) return false;
      if (term && !`${e.employeeFirstName} ${e.employeeLastName}`.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [data, search, statusFilter, activityFilter]);

  if (!canView) {
    return (
      <div className="mobile-settings">
        <h1>Employees</h1>
        <Link to="/mobile/settings" className="mobile-action-button mobile-action-secondary">
          Back to Settings
        </Link>
        <p className="error-text">You don't have permission to view this page.</p>
      </div>
    );
  }

  return (
    <div className="mobile-settings mobile-employees-screen">
      <h1>Employees</h1>
      <Link to="/mobile/settings" className="mobile-action-button mobile-action-secondary">
        Back to Settings
      </Link>

      {forbidden && <p className="error-text">You don't have permission to view this page.</p>}

      {!forbidden && (
        <>
          <div className="mobile-employees-controls">
            <input
              type="text"
              className="mobile-employees-search"
              placeholder="Search employees..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="mobile-employees-filter-row">
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}>
                <option value="all">All statuses</option>
                <option value="working">Working</option>
                <option value="on_break">On break</option>
              </select>
              <select value={activityFilter} onChange={(e) => setActivityFilter(e.target.value)}>
                <option value="all">All activities</option>
                {activityOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            {data && (
              <p className="mobile-employees-updated">
                Last updated {new Date(data.generatedAt).toLocaleTimeString()}
                {refreshing ? " · Refreshing..." : ""}
              </p>
            )}
          </div>

          {error && <p className="error-text">{error}</p>}

          <div
            ref={listRef}
            className="mobile-employees-list"
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          >
            {pulling && <p className="mobile-employees-pull-indicator">Release to refresh…</p>}

            {loading && !data && (
              <div className="mobile-employees-skeleton" aria-hidden="true">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="mobile-employees-skeleton-card" />
                ))}
              </div>
            )}

            {data && data.employees.length === 0 && (
              <p className="placeholder-page">No employees are currently working</p>
            )}

            {data && data.employees.length > 0 && filtered.length === 0 && (
              <p className="placeholder-page">No employees match your search or filter.</p>
            )}

            {filtered.map((card) => (
              <EmployeeLiveCard key={card.employeeId} card={card} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function EmployeeLiveCard({ card }: { card: LiveEmployeeCard }) {
  const locations = locationLines(card);
  return (
    <div className="mobile-employee-card">
      <Avatar photoUrl={card.photoUrl} firstName={card.employeeFirstName} lastName={card.employeeLastName} size="small" />
      <div className="mobile-employee-card-body">
        <div className="mobile-employee-card-top">
          <span className="mobile-employee-card-name">
            {card.employeeFirstName} {card.employeeLastName}
          </span>
          <span className={`mobile-employee-card-status mobile-employee-card-status-${card.status}`}>
            {statusLabel(card.status)}
          </span>
        </div>

        {card.status === "working" ? (
          <>
            <div className="mobile-employee-card-activity">{card.activityName}</div>
            {locations.map((line) => (
              <div key={line} className="mobile-employee-card-location">
                {line}
              </div>
            ))}
            <div className="mobile-employee-card-row">
              <span>Time on activity: </span>
              <ActivityTimer startedAt={card.statusSince} />
            </div>
            <div className="mobile-employee-card-row">
              <span>Weekly speed: </span>
              <span>{speedLabel(card)}</span>
            </div>
          </>
        ) : (
          <>
            <div className="mobile-employee-card-activity">{card.breakType}</div>
            <div className="mobile-employee-card-row">
              <span>Break duration: </span>
              <ActivityTimer startedAt={card.statusSince} />
            </div>
            {card.resumingActivityName && (
              <div className="mobile-employee-card-row">
                <span>Will resume: </span>
                <span>{card.resumingActivityName}</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
