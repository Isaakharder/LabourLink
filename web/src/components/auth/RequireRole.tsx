import { ReactElement } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";

interface RequireRoleProps {
  roles: string[];
  children: ReactElement;
}

// First frontend role-gate in the app — until now, every desktop page
// behind requireAuth was visible to any authenticated employee, with
// role-specific restrictions only enforced server-side (see
// requireRole in server/src/middleware/auth.ts). This guards a route the
// same way: an unauthorized role hitting the URL directly is redirected,
// not just kept from seeing the nav link (see Sidebar.tsx's matching
// PRIMARY_NAV filter).
export function RequireRole({ roles, children }: RequireRoleProps) {
  const { employee } = useAuth();
  if (!employee || !roles.includes(employee.securityRole)) {
    return <Navigate to="/inputs" replace />;
  }
  return children;
}
