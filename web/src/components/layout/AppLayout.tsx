import { useState } from "react";
import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";

// The Greenhouse Layout editor is the only page that hides the sidebar or
// goes full-bleed today, but that state lives here (not in that page) so
// it's reachable via react-router's Outlet context from any nested route,
// and so leaving the route can never strand an unrelated page in a
// hidden-nav / no-padding state — the state belongs to the shell that owns
// Sidebar and .app-content, not to any one page.
export interface AppShellContext {
  sidebarHidden: boolean;
  setSidebarHidden: (hidden: boolean) => void;
  // Full-bleed drops .app-content's padding and internal scrollbar, for a
  // page (like the Greenhouse Layout canvas) that wants to own its own
  // scrolling/viewport instead of sitting inside the normal admin frame.
  setContentFullBleed: (fullBleed: boolean) => void;
}

export function AppLayout() {
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [contentFullBleed, setContentFullBleed] = useState(false);

  return (
    <div className="app-shell">
      <Sidebar hidden={sidebarHidden} onRestore={() => setSidebarHidden(false)} />
      <main className={`app-content${contentFullBleed ? " app-content-full-bleed" : ""}`}>
        <Outlet context={{ sidebarHidden, setSidebarHidden, setContentFullBleed } satisfies AppShellContext} />
      </main>
    </div>
  );
}
