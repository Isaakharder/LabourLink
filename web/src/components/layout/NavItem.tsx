import { LucideIcon } from "lucide-react";
import { NavLink } from "react-router-dom";

interface NavItemProps {
  to: string;
  icon: LucideIcon;
  label: string;
}

export function NavItem({ to, icon: Icon, label }: NavItemProps) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
    >
      <Icon size={18} className="nav-item-icon" />
      <span className="nav-item-label">{label}</span>
    </NavLink>
  );
}
