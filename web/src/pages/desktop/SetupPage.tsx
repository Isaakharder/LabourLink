import { Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { PageHeader } from "../../components/layout/PageHeader";
import { DevicesTab } from "./setup/DevicesTab";
import { MessagesTab } from "./setup/MessagesTab";
import { GreenhouseLayoutTab } from "./setup/GreenhouseLayoutTab";

export function SetupPage() {
  // The Greenhouse Layout editor is a full-screen, chrome-free canvas
  // workspace (it manages its own Back control) — the normal Setup
  // title/subtitle/tab nav would just eat viewport space it needs, and
  // aren't reachable anyway once the editor's own toolbar takes over.
  const isLayoutEditor = useLocation().pathname.endsWith("/layout");

  if (isLayoutEditor) {
    return (
      <Routes>
        <Route path="layout" element={<GreenhouseLayoutTab />} />
      </Routes>
    );
  }

  return (
    <>
      <PageHeader title="Setup" description="Pair phones, manage device assignments, and build the greenhouse layout." />

      <nav className="tabs">
        <NavLink to="" end className={({ isActive }) => `tab${isActive ? " tab-active" : ""}`}>
          Devices
        </NavLink>
        <NavLink to="layout" className={({ isActive }) => `tab${isActive ? " tab-active" : ""}`}>
          Greenhouse Layout
        </NavLink>
        <NavLink to="messages" className={({ isActive }) => `tab${isActive ? " tab-active" : ""}`}>
          Messages
        </NavLink>
      </nav>

      <Routes>
        <Route index element={<DevicesTab />} />
        <Route path="messages" element={<MessagesTab />} />
        <Route path="*" element={<Navigate to="." replace />} />
      </Routes>
    </>
  );
}
