import { Navigate, useLocation } from "react-router-dom";

// The standalone Activities page became Basic data → Jobs. Old bookmarks
// and links land here and are replaced (not pushed) by the new location,
// so Back goes to wherever the user came from rather than bouncing through
// /activities again. Any query string or hash is carried over unchanged.
// The old Activity Groups tab (/activities/groups) lands on Jobs as well:
// groups were replaced by each employee's own Jobs.
export function LegacyActivitiesRedirect() {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: "/basic-data/jobs", search, hash }} replace />;
}
