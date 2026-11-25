import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { DirectoryTab } from "./employees/DirectoryTab";
import { EmploymentTimelineTab } from "./employees/EmploymentTimelineTab";
import { EmployeeGroupsTab } from "./employees/EmployeeGroupsTab";
import { WorkPermitsTab } from "./employees/WorkPermitsTab";

// managersOnly tabs are hidden (and their address redirects to Directory)
// for other roles; the server enforces the same restriction on their data.
const TABS = [
  { path: "directory", label: "Directory", element: <DirectoryTab /> },
  { path: "employment-timeline", label: "Employment Timeline", element: <EmploymentTimelineTab /> },
  { path: "employee-groups", label: "Employee Groups", element: <EmployeeGroupsTab /> },
  { path: "work-permits", label: "Work Permits", element: <WorkPermitsTab />, managersOnly: true },
];

export function EmployeesPage() {
  const { employee } = useAuth();
  const isManager = employee?.securityRole === "Administrator" || employee?.securityRole === "Manager";
  const tabs = TABS.filter((tab) => !tab.managersOnly || isManager);

  return (
    <>
      <div className="employees-page-topbar">
        <nav className="tabs">
          {tabs.map((tab) => (
            <NavLink key={tab.path} to={tab.path} className={({ isActive }) => `tab${isActive ? " tab-active" : ""}`}>
              {tab.label}
            </NavLink>
          ))}
        </nav>
        {employee && (
          <span className="page-header-user">
            {employee.firstName} {employee.lastName}
          </span>
        )}
      </div>

      <Routes>
        {TABS.map((tab) => (
          <Route
            key={tab.path}
            path={tab.path}
            // A managers-only address redirects only once the signed-in role
            // is known, so a deep link isn't lost while the session loads.
            element={!tab.managersOnly || isManager ? tab.element : employee ? <Navigate to="../directory" replace /> : null}
          />
        ))}
        <Route index element={<Navigate to="directory" replace />} />
        <Route path="*" element={<Navigate to="directory" replace />} />
      </Routes>
    </>
  );
}
