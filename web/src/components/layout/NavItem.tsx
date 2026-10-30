import { LucideIcon } from "lucide-react";
import { NavLink } from "react-router-dom";
import { useUnsavedChangesGuard } from "../../context/UnsavedChangesContext";

interface NavItemProps {
  to: string;
  // Omitted for a child entry inside an expandable group (Sidebar NavGroup).
  icon?: LucideIcon;
  label: string;
}

export function NavItem({ to, icon: Icon, label }: NavItemProps) {
  const { confirmNavigation } = useUnsavedChangesGuard();

  return (
    <NavLink
      to={to}
      // Lets a page tell "opened from the main navigation" apart from its own
      // URL updates — Inputs restarts at today on it, even when re-clicked
      // while already open (see InputsPage).
      state={{ fromMainNav: true }}
      className={({ isActive }) => `nav-item${Icon ? "" : " nav-item-child"}${isActive ? " active" : ""}`}
      onClick={(e) => {
        if (!confirmNavigation()) e.preventDefault();
      }}
    >
      {Icon && <Icon size={18} className="nav-item-icon" />}
      <span className="nav-item-label">{label}</span>
    </NavLink>
  );
}
