import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { PageHeader } from "../../components/layout/PageHeader";
import { ActivitiesTab } from "./activities/ActivitiesTab";
import { ActivityGroupsTab } from "./activities/ActivityGroupsTab";

export function ActivitiesPage() {
  return (
    <>
      <PageHeader title="Activities" description="Manage activities, activity groups, and employee assignments." />

      <nav className="tabs">
        <NavLink to="" end className={({ isActive }) => `tab${isActive ? " tab-active" : ""}`}>
          Activities
        </NavLink>
        <NavLink to="groups" className={({ isActive }) => `tab${isActive ? " tab-active" : ""}`}>
          Activity Groups
        </NavLink>
      </nav>

      <Routes>
        <Route index element={<ActivitiesTab />} />
        <Route path="groups" element={<ActivityGroupsTab />} />
        <Route path="*" element={<Navigate to="." replace />} />
      </Routes>
    </>
  );
}
