import { Navigate, useLocation } from "react-router-dom";

// The standalone Activities page became Basic data → Jobs. Old bookmarks
// and links land here and are replaced (not pushed) by the new location,
// so Back goes to wherever the user came from rather than bouncing through
// /activities again. Any query string or hash is carried over unchanged.
export function legacyActivitiesTarget(pathname: string): string {
  if (/^\/activities\/groups(\/|$)/.test(pathname)) return "/basic-data/activity-groups";
  return "/basic-data/jobs";
}

export function LegacyActivitiesRedirect() {
  const { pathname, search, hash } = useLocation();
  return <Navigate to={{ pathname: legacyActivitiesTarget(pathname), search, hash }} replace />;
}
