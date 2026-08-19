import {
  ChevronRight,
  ClipboardList,
  Database,
  FileBarChart,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Settings,
  Smartphone,
  Sprout,
  TriangleAlert,
  Users,
  Wrench,
} from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { useUnsavedChangesGuard } from "../../context/UnsavedChangesContext";
import { NavItem } from "./NavItem";

// Add future sections here (Reports, Time Logs, Schedules, Organizations,
// Administration, Food Safety, CropLink) as their routes/pages land.
// `roles`, when set, hides the nav item for anyone else — App.tsx's
// RequireRole wrapper enforces the same list on the route itself, so direct
// navigation is blocked too, not just the link.
const PRIMARY_NAV: { to: string; icon: typeof LayoutDashboard; label: string; roles?: string[] }[] = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/greenhouse", icon: Sprout, label: "Greenhouse", roles: ["Administrator", "Manager"] },
  { to: "/inputs", icon: ClipboardList, label: "Inputs" },
  { to: "/reports", icon: FileBarChart, label: "Reports", roles: ["Administrator", "Manager"] },
  { to: "/employees", icon: Users, label: "Employees" },
  { to: "/activities", icon: ListChecks, label: "Activities" },
  { to: "/basic-data", icon: Database, label: "Basic data" },
  { to: "/devices", icon: Smartphone, label: "Devices" },
  { to: "/sync-conflicts", icon: TriangleAlert, label: "Sync conflicts", roles: ["Administrator", "Manager"] },
  { to: "/setup", icon: Wrench, label: "Setup" },
];

interface SidebarProps {
  hidden?: boolean;
  onRestore?: () => void;
}

export function Sidebar({ hidden, onRestore }: SidebarProps) {
  const { employee, logout } = useAuth();
  const { confirmNavigation } = useUnsavedChangesGuard();
  const visibleNav = PRIMARY_NAV.filter(
    (item) => !item.roles || (employee && item.roles.includes(employee.securityRole))
  );

  if (hidden) {
    return (
      <button type="button" className="sidebar-restore-tab" onClick={onRestore} aria-label="Show navigation">
        <ChevronRight size={16} />
      </button>
    );
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-brand-text">LabourLink</span>
      </div>

      <nav className="sidebar-nav">
        {visibleNav.map((item) => (
          <NavItem key={item.to} to={item.to} icon={item.icon} label={item.label} />
        ))}
      </nav>

      <div className="sidebar-spacer" />

      <div className="sidebar-bottom">
        <NavItem to="/settings" icon={Settings} label="Settings" />
        <button
          type="button"
          className="nav-item nav-item-button"
          onClick={() => {
            if (confirmNavigation()) logout();
          }}
        >
          <LogOut size={18} className="nav-item-icon" />
          <span className="nav-item-label">Sign Out</span>
        </button>
      </div>
    </aside>
  );
}
