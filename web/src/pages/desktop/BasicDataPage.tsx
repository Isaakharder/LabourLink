import { useEffect, useRef } from "react";
import { Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { PageHeader } from "../../components/layout/PageHeader";
import { JobsTab } from "./basic-data/JobsTab";
import { ActivityGroupsTab } from "./basic-data/ActivityGroupsTab";
import { BreaksTab } from "./basic-data/BreaksTab";
import { RowsTab } from "./basic-data/RowsTab";
import { EmployeeBlocksTab } from "./basic-data/EmployeeBlocksTab";
import { DensityTab } from "./basic-data/DensityTab";
import { VarietiesTab } from "./basic-data/VarietiesTab";
import { CarriersTab } from "./basic-data/CarriersTab";

// Add future Basic Data sections here (Holidays, Pay Codes, Departments,
// Teams, Nationalities, Languages, ...) as their tabs land. Each entry
// drives both the tab nav and its route below. Jobs (formerly the
// standalone Activities page) comes first and is what Basic data opens on,
// so the default tab is always the leftmost one.
const BASIC_DATA_TABS = [
  { path: "jobs", label: "Jobs", element: <JobsTab /> },
  { path: "activity-groups", label: "Activity Groups", element: <ActivityGroupsTab /> },
  { path: "breaks", label: "Breaks", element: <BreaksTab /> },
  { path: "rows", label: "Rows", element: <RowsTab /> },
  { path: "employee-blocks", label: "Employee Blocks", element: <EmployeeBlocksTab /> },
  { path: "density", label: "Density", element: <DensityTab /> },
  { path: "varieties", label: "Varieties", element: <VarietiesTab /> },
  { path: "carriers", label: "Carriers", element: <CarriersTab /> },
];

export function BasicDataPage() {
  const { pathname } = useLocation();
  const tabsRef = useRef<HTMLElement>(null);

  // At narrow widths the tab bar scrolls; keep the current tab in view
  // (e.g. a direct link to Carriers, the last tab).
  useEffect(() => {
    tabsRef.current?.querySelector(".tab-active")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [pathname]);

  return (
    <>
      <PageHeader title="Basic data" description="Manage shared configuration used throughout LabourLink." />

      <nav ref={tabsRef} className="tabs tabs-scroll" aria-label="Basic data sections">
        {BASIC_DATA_TABS.map((tab) => (
          <NavLink key={tab.path} to={tab.path} className={({ isActive }) => `tab${isActive ? " tab-active" : ""}`}>
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <Routes>
        {BASIC_DATA_TABS.map((tab) => (
          <Route key={tab.path} path={tab.path} element={tab.element} />
        ))}
        <Route index element={<Navigate to="jobs" replace />} />
        <Route path="*" element={<Navigate to="jobs" replace />} />
      </Routes>
    </>
  );
}
