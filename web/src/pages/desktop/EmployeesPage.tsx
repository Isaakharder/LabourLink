import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { DirectoryTab } from "./employees/DirectoryTab";
import { EmploymentTimelineTab } from "./employees/EmploymentTimelineTab";

const TABS = [
  { path: "directory", label: "Directory", element: <DirectoryTab /> },
  { path: "employment-timeline", label: "Employment Timeline", element: <EmploymentTimelineTab /> },
];

export function EmployeesPage() {
  const { employee } = useAuth();

  return (
    <>
      <div className="employees-page-topbar">
        <nav className="tabs">
          {TABS.map((tab) => (
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
          <Route key={tab.path} path={tab.path} element={tab.element} />
        ))}
        <Route index element={<Navigate to="directory" replace />} />
        <Route path="*" element={<Navigate to="directory" replace />} />
      </Routes>
    </>
  );
}
