import {
  ClipboardList,
  LayoutDashboard,
  LogOut,
  Settings,
  Smartphone,
  Users,
  Wrench,
} from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { NavItem } from "./NavItem";

// Add future sections here (Reports, Time Logs, Schedules, Organizations,
// Administration, Food Safety, CropLink) as their routes/pages land.
const PRIMARY_NAV = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/inputs", icon: ClipboardList, label: "Inputs" },
  { to: "/employees", icon: Users, label: "Employees" },
  { to: "/devices", icon: Smartphone, label: "Devices" },
  { to: "/setup", icon: Wrench, label: "Setup" },
];

export function Sidebar() {
  const { logout } = useAuth();

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-brand-text">LabourLink</span>
      </div>

      <nav className="sidebar-nav">
        {PRIMARY_NAV.map((item) => (
          <NavItem key={item.to} to={item.to} icon={item.icon} label={item.label} />
        ))}
      </nav>

      <div className="sidebar-spacer" />

      <div className="sidebar-bottom">
        <NavItem to="/settings" icon={Settings} label="Settings" />
        <button type="button" className="nav-item nav-item-button" onClick={() => logout()}>
          <LogOut size={18} className="nav-item-icon" />
          <span className="nav-item-label">Sign Out</span>
        </button>
      </div>
    </aside>
  );
}
