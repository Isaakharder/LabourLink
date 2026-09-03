import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { PageHeader } from "../../components/layout/PageHeader";
import { DirectoryTab } from "./employees/DirectoryTab";
import { EmploymentTimelineTab } from "./employees/EmploymentTimelineTab";

const TABS = [
  { path: "directory", label: "Directory", element: <DirectoryTab /> },
  { path: "employment-timeline", label: "Employment Timeline", element: <EmploymentTimelineTab /> },
];

export function EmployeesPage() {
  return (
    <>
      <PageHeader title="Employees" description="Manage employee profiles, device assignments, and employment history." />

      <nav className="tabs">
        {TABS.map((tab) => (
          <NavLink key={tab.path} to={tab.path} className={({ isActive }) => `tab${isActive ? " tab-active" : ""}`}>
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <Routes>
        {TABS.map((tab) => (
          <Route key={tab.path} path={tab.path} element={tab.element} />
        ))}
        <Route index element={<Navigate to="directory" replace />} />
        <Route path="*" element={<Navigate to="directory" replace />} />
      </Routes>
    </>
  );
}
