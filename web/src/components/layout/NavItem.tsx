import { LucideIcon } from "lucide-react";
import { NavLink } from "react-router-dom";
import { useUnsavedChangesGuard } from "../../context/UnsavedChangesContext";

interface NavItemProps {
  to: string;
  icon: LucideIcon;
  label: string;
}

export function NavItem({ to, icon: Icon, label }: NavItemProps) {
  const { confirmNavigation } = useUnsavedChangesGuard();

  return (
    <NavLink
      to={to}
      className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
      onClick={(e) => {
        if (!confirmNavigation()) e.preventDefault();
      }}
    >
      <Icon size={18} className="nav-item-icon" />
      <span className="nav-item-label">{label}</span>
    </NavLink>
  );
}
