import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { PageHeader } from "../../components/layout/PageHeader";
import { BreaksTab } from "./basic-data/BreaksTab";
import { RowsTab } from "./basic-data/RowsTab";
import { EmployeeBlocksTab } from "./basic-data/EmployeeBlocksTab";
import { VarietiesTab } from "./basic-data/VarietiesTab";
import { CarriesTab } from "./basic-data/CarriesTab";

// Add future Basic Data sections here (Holidays, Pay Codes, Departments,
// Teams, Nationalities, Languages, ...) as their tabs land. Each entry
// drives both the tab nav and its route below.
const TABS = [
  { path: "breaks", label: "Breaks", element: <BreaksTab /> },
  { path: "rows", label: "Rows", element: <RowsTab /> },
  { path: "employee-blocks", label: "Employee Blocks", element: <EmployeeBlocksTab /> },
  { path: "varieties", label: "Varieties", element: <VarietiesTab /> },
  { path: "carries", label: "Carries", element: <CarriesTab /> },
];

export function BasicDataPage() {
  return (
    <>
      <PageHeader title="Basic data" description="Manage shared configuration used throughout LabourLink." />

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
        <Route index element={<Navigate to="breaks" replace />} />
        <Route path="*" element={<Navigate to="breaks" replace />} />
      </Routes>
    </>
  );
}
