import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { PageHeader } from "../../components/layout/PageHeader";
import { BreaksTab } from "./basic-data/BreaksTab";

// Add future Basic Data sections here (Holidays, Pay Codes, Departments,
// Teams, Nationalities, Languages, ...) as their tabs land. Each entry
// drives both the tab nav and its route below.
const TABS = [{ path: "", label: "Breaks", element: <BreaksTab /> }];

export function BasicDataPage() {
  return (
    <>
      <PageHeader title="Basic data" description="Manage shared configuration used throughout LabourLink." />

      <nav className="tabs">
        {TABS.map((tab) => (
          <NavLink
            key={tab.path || "index"}
            to={tab.path}
            end={tab.path === ""}
            className={({ isActive }) => `tab${isActive ? " tab-active" : ""}`}
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <Routes>
        {TABS.map((tab) =>
          tab.path === "" ? (
            <Route key="index" index element={tab.element} />
          ) : (
            <Route key={tab.path} path={tab.path} element={tab.element} />
          )
        )}
        <Route path="*" element={<Navigate to="." replace />} />
      </Routes>
    </>
  );
}
