import { NavLink, Outlet } from "react-router-dom";
import { BarChart3, Coffee, House, Settings } from "lucide-react";
import { WorkSessionProvider, useWorkSession } from "../../context/WorkSessionContext";
import { MessagesProvider } from "../../context/MessagesContext";
import { ConfirmEndDayModal } from "./ConfirmEndDayModal";
import { PendingMessageOverlay } from "./PendingMessageOverlay";
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
            <span>End Work</span>
          </button>
        ) : (
          <NavLink to="/mobile/home" className={navItemClass}>
            <House size={22} />
            <span>Home</span>
          </NavLink>
        )}

        {status === "break" ? (
          <button type="button" className="mobile-nav-item" disabled={busy} onClick={endBreak}>
            <Coffee size={22} />
            <span>End Break</span>
          </button>
        ) : (
          <button type="button" className="mobile-nav-item" disabled={status !== "work" || busy} onClick={startBreak}>
            <Coffee size={22} />
            <span>Start Break</span>
          </button>
        )}

        <NavLink to="/mobile/stats" className={navItemClass}>
          <BarChart3 size={22} />
          <span>Stats</span>
        </NavLink>
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
        {/* Rendered as a sibling of .mobile-shell, not inside it — a fixed,
            full-viewport overlay (see its own CSS) that must cover the nav
            bar too, not just .mobile-content. */}
        <PendingMessageOverlay />
        <NativePushBridge />
      </WorkSessionProvider>
    </MessagesProvider>
  );
}
