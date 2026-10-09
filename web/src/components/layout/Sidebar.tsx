import { useState } from "react";
import { useLocation } from "react-router-dom";
import {
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Database,
  FileBarChart,
  LayoutDashboard,
  ListChecks,
  LogOut,
  MonitorPlay,
  Settings,
  Smartphone,
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
// An entry with `children` is an expandable group (Display > Setup / Map);
// clicking it only opens/closes the group, and it starts open while one of
// its pages is the current route.
interface NavEntry {
  to: string;
  icon: typeof LayoutDashboard;
  label: string;
  roles?: string[];
  children?: { to: string; label: string }[];
}

const PRIMARY_NAV: NavEntry[] = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  {
    to: "/display",
    icon: MonitorPlay,
    label: "Display",
    roles: ["Administrator", "Manager"],
    children: [
      { to: "/display/setup", label: "Setup" },
      { to: "/display/map", label: "Map" },
    ],
  },
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
        {visibleNav.map((item) =>
          item.children ? (
            <NavGroup key={item.to} item={item} />
          ) : (
            <NavItem key={item.to} to={item.to} icon={item.icon} label={item.label} />
          )
        )}
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

function NavGroup({ item }: { item: NavEntry }) {
  const location = useLocation();
  const inGroup = location.pathname === item.to || location.pathname.startsWith(`${item.to}/`);
  const [open, setOpen] = useState(inGroup);
  const expanded = open || inGroup;
  const Icon = item.icon;
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div className="nav-group">
      <button
        type="button"
        className={`nav-item nav-item-button nav-group-toggle${inGroup ? " active-group" : ""}`}
        aria-expanded={expanded}
        onClick={() => setOpen(!expanded)}
      >
        <Icon size={18} className="nav-item-icon" />
        <span className="nav-item-label">{item.label}</span>
        <Chevron size={16} className="nav-group-chevron" />
      </button>
      {expanded && (
        <div className="nav-group-children">
          {item.children!.map((child) => (
            <NavItem key={child.to} to={child.to} label={child.label} />
          ))}
        </div>
      )}
    </div>
  );
}
