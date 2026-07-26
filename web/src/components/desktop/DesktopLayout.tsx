import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";

export function DesktopLayout() {
  const { employee, logout } = useAuth();

  return (
    <div className="desktop-shell">
      <header className="desktop-header">
        <span className="brand">LabourLink</span>
        <nav className="desktop-nav">
          <NavLink to="/inputs">Inputs</NavLink>
          <NavLink to="/employees">Employees</NavLink>
          <NavLink to="/setup">Setup</NavLink>
        </nav>
        <div className="desktop-user">
          <span>
            {employee?.firstName} {employee?.lastName}
          </span>
          <button onClick={() => logout()}>Sign out</button>
        </div>
      </header>
      <main className="desktop-content">
        <Outlet />
      </main>
    </div>
  );
}
