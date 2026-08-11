import { NavLink, Outlet } from "react-router-dom";
import { BarChart3, Coffee, House, Settings } from "lucide-react";
import { WorkSessionProvider, useWorkSession } from "../../context/WorkSessionContext";
import { MessagesProvider } from "../../context/MessagesContext";
import { t } from "../../lib/i18n";
import { ConfirmEndDayModal } from "./ConfirmEndDayModal";
import { PendingMessageOverlay } from "./PendingMessageOverlay";
import { ReassignmentOverlay } from "./ReassignmentOverlay";
import { NativePushBridge } from "./NativePushBridge";

function navItemClass({ isActive }: { isActive: boolean }): string {
  return `mobile-nav-item${isActive ? " active" : ""}`;
}

// Reads work status from WorkSessionContext (shared with HomeScreen) so End
// Work / Start Break / End Break stay correct and actionable from every
// mobile tab, not just Home — the nav bar is fixed and persists across
// route changes, so it needs the same live status HomeScreen shows.
function MobileNav() {
  const {
    me,
    language,
    busy,
    endDaySubmitting,
    endDayConfirmOpen,
    endDayError,
    startBreak,
    endBreak,
    openEndDayConfirm,
    closeEndDayConfirm,
    confirmEndDay,
  } = useWorkSession();
  const status = me?.status ?? "idle";
  const isWorkingOrOnBreak = status === "work" || status === "break";

  return (
    <>
      <nav className="mobile-nav">
        {isWorkingOrOnBreak ? (
          <button
            type="button"
            className="mobile-nav-item active"
            disabled={busy || endDaySubmitting}
            onClick={openEndDayConfirm}
          >
            <House size={22} />
            <span>{t(language, "navEndWork")}</span>
          </button>
        ) : (
          <NavLink to="/mobile/home" className={navItemClass}>
            <House size={22} />
            <span>{t(language, "navHome")}</span>
          </NavLink>
        )}

        {status === "break" ? (
          <button type="button" className="mobile-nav-item" disabled={busy} onClick={endBreak}>
            <Coffee size={22} />
            <span>{t(language, "navEndBreak")}</span>
          </button>
        ) : (
          <button type="button" className="mobile-nav-item" disabled={status !== "work" || busy} onClick={startBreak}>
            <Coffee size={22} />
            <span>{t(language, "navStartBreak")}</span>
          </button>
        )}

        <NavLink to="/mobile/stats" className={navItemClass}>
          <BarChart3 size={22} />
          <span>{t(language, "navStats")}</span>
        </NavLink>
        {/* Settings is never translated, regardless of the employee's
            preferred language — see the feature report. */}
        <NavLink to="/mobile/settings" className={navItemClass}>
          <Settings size={22} />
          <span>Settings</span>
        </NavLink>
      </nav>

      {endDayConfirmOpen && (
        <ConfirmEndDayModal
          submitting={endDaySubmitting}
          error={endDayError}
          onConfirm={confirmEndDay}
          onCancel={closeEndDayConfirm}
          language={language}
        />
      )}
    </>
  );
}

export function MobileLayout() {
  return (
    <MessagesProvider>
      <WorkSessionProvider>
        <div className="mobile-shell">
          <main className="mobile-content">
            <Outlet />
          </main>
          <MobileNav />
        </div>
        {/* Rendered as siblings of .mobile-shell, not inside it — fixed,
            full-viewport overlays (see their shared .message-overlay CSS)
            that must cover the nav bar too, not just .mobile-content.
            ReassignmentOverlay is mounted after PendingMessageOverlay so it
            paints on top in the (unlikely) case both are pending at once —
            a reassignment is the more fundamental change of the two. */}
        <PendingMessageOverlay />
        <ReassignmentOverlay />
        <NativePushBridge />
      </WorkSessionProvider>
    </MessagesProvider>
  );
}
