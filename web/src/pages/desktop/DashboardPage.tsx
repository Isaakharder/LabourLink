import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader } from "../../components/layout/PageHeader";
import { RowStemCard } from "../../components/dashboard/RowStemCard";
import { PickingCard } from "../../components/dashboard/PickingCard";
import { DashboardSettingsPanel } from "../../components/dashboard/DashboardSettingsPanel";
import { BinCompletionsPanel } from "../../components/dashboard/BinCompletionsPanel";
import { WorkPermitAlertsSection } from "../../components/dashboard/WorkPermitAlertsSection";
import { useAuth } from "../../context/AuthContext";
import { api, ApiError } from "../../lib/api";
import { DashboardCard, GetDashboardCardsResponse } from "../../lib/dashboardTypes";

// Live overview, not a report — a fixed few-tens-of-seconds cadence keeps
// cards reasonably current without hammering the endpoint, same spirit as
// GreenhousePage's own preview polling (PREVIEW_POLL_INTERVAL_MS there).
const POLL_INTERVAL_MS = 45000;

export function DashboardPage() {
  const { employee } = useAuth();
  const canEdit = employee?.securityRole === "Administrator" || employee?.securityRole === "Manager";

  const [cards, setCards] = useState<DashboardCard[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showBinCompletions, setShowBinCompletions] = useState(false);
  const loadingRef = useRef(false);

  const load = useCallback(async (silent: boolean) => {
    // A silent background refresh (poll/focus) never flashes the loading
    // skeleton over already-shown cards, and never overlaps a call already
    // in flight (a slow response landing after a newer one would otherwise
    // stomp fresher data with stale data).
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const res = await api<GetDashboardCardsResponse>("/api/dashboard/cards");
      setCards(res.cards);
      setLoadError(null);
    } catch (err) {
      if (!silent) setCards(null);
      setLoadError(err instanceof ApiError ? err.message : "Could not load the Dashboard");
    } finally {
      loadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  useEffect(() => {
    const interval = window.setInterval(() => load(true), POLL_INTERVAL_MS);
    function onFocus() {
      load(true);
    }
    function onVisibilityChange() {
      if (document.visibilityState === "visible") load(true);
    }
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [load]);

  return (
    <>
      <div className="page-header">
        <div className="page-header-text">
          <h1 className="page-header-title">Dashboard</h1>
          <p className="page-header-description">Who's currently working, and how they're doing this week.</p>
        </div>
        <div className="dashboard-header-actions">
          {canEdit && (
            <button type="button" onClick={() => setShowBinCompletions(true)}>
              Bin Completions
            </button>
          )}
          {canEdit && (
            <button type="button" className="employees-add-button" onClick={() => setShowSettings(true)}>
              Edit Dashboard
            </button>
          )}
          {employee && (
            <span className="page-header-user">
              {employee.firstName} {employee.lastName}
            </span>
          )}
        </div>
      </div>

      {canEdit && <WorkPermitAlertsSection />}

      {loadError && <p className="error-text">{loadError}</p>}

      {!cards && !loadError ? (
        <div className="dashboard-card-grid" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="dashboard-card dashboard-card-skeleton" />
          ))}
        </div>
      ) : cards && cards.length === 0 ? (
        <p className="placeholder-page">
          {canEdit
            ? "No one is currently doing a Dashboard-tracked activity. Click Edit Dashboard to choose which activities to track, or check back once someone clocks in."
            : "No one is currently doing a Dashboard-tracked activity."}
        </p>
      ) : cards ? (
        <div className="dashboard-card-grid">
          {cards.map((card) =>
            card.cardType === "row_stem" ? (
              <RowStemCard key={card.employeeId} card={card} />
            ) : (
              <PickingCard key={card.employeeId} card={card} />
            )
          )}
        </div>
      ) : null}

      {showSettings && (
        <DashboardSettingsPanel
          onClose={() => setShowSettings(false)}
          onSaved={() => {
            setShowSettings(false);
            load(false);
          }}
        />
      )}
      {showBinCompletions && (
        <BinCompletionsPanel onClose={() => setShowBinCompletions(false)} onCompleted={() => load(true)} />
      )}
    </>
  );
}
