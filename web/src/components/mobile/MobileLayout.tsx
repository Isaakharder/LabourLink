import { NavLink, Outlet } from "react-router-dom";

export function MobileLayout() {
  return (
    <div className="mobile-shell">
      <main className="mobile-content">
        <Outlet />
      </main>
      <nav className="mobile-nav">
        <NavLink to="/mobile/home" className="mobile-nav-item mobile-nav-left">
          Home
        </NavLink>
        <div className="mobile-nav-right">
          {/* Break is visual-only for V1 — intentionally does nothing on tap. */}
          <button type="button" className="mobile-nav-item" disabled>
            Break
          </button>
          <NavLink to="/mobile/sync" className="mobile-nav-item">
            Sync
          </NavLink>
          <NavLink to="/mobile/settings" className="mobile-nav-item">
            Settings
          </NavLink>
        </div>
      </nav>
    </div>
  );
}
