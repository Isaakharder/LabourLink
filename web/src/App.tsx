import { Navigate, Route, Routes, useLocation, useSearchParams } from "react-router-dom";
import { AppLayout } from "./components/layout/AppLayout";
import { MobileLayout } from "./components/mobile/MobileLayout";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { DevicePairingProvider, useDevicePairing } from "./context/DevicePairingContext";
import { ActivitiesPage } from "./pages/desktop/ActivitiesPage";
import { BasicDataPage } from "./pages/desktop/BasicDataPage";
import { DashboardPage } from "./pages/desktop/DashboardPage";
import { DevicesPage } from "./pages/desktop/DevicesPage";
import { EmployeesPage } from "./pages/desktop/EmployeesPage";
import { GreenhouseDisplayPage } from "./pages/desktop/GreenhouseDisplayPage";
import { GreenhousePage } from "./pages/desktop/GreenhousePage";
import { InputsPage } from "./pages/desktop/InputsPage";
import { LoginPage } from "./pages/desktop/LoginPage";
import { ReportsPage } from "./pages/desktop/ReportsPage";
import { ReportViewPage } from "./pages/desktop/ReportViewPage";
import { ResetPinPage } from "./pages/desktop/ResetPinPage";
import { SettingsPage } from "./pages/desktop/SettingsPage";
import { SetupPage } from "./pages/desktop/SetupPage";
import { RequireRole } from "./components/auth/RequireRole";
import { HomeScreen } from "./pages/mobile/HomeScreen";
import { PairingScreen } from "./pages/mobile/PairingScreen";
import { SettingsScreen } from "./pages/mobile/SettingsScreen";
import { StatsScreen } from "./pages/mobile/StatsScreen";
import { useIsMobile } from "./lib/useIsMobile";

function DesktopApp() {
  const { employee, loading } = useAuth();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  // The break-room TV never has a login — it's reached via an unguessable
  // per-display token embedded in the URL itself (see
  // server/src/middleware/displayAuth.ts), not a session. This bypass runs
  // before the `!employee` gate below (same pattern as the /reset-pin deep
  // link) so the TV never waits on, or depends on, any auth/session state.
  const displayMatch = location.pathname.match(/^\/greenhouse\/display\/([^/]+)$/);
  if (displayMatch) {
    return <GreenhouseDisplayPage displayKey={displayMatch[1]} />;
  }

  if (loading) return <p className="centered-message">Loading...</p>;
  if (!employee) {
    // A "forgot PIN" email link lands here while logged out. LoginPage
    // otherwise renders unconditionally (bypassing <Routes> below), so this
    // deep link needs its own check rather than a matched route.
    const token = searchParams.get("token");
    if (location.pathname === "/reset-pin" && token) {
      return <ResetPinPage token={token} />;
    }
    return <LoginPage />;
  }

  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<Navigate to="/inputs" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route
          path="greenhouse"
          element={
            <RequireRole roles={["Administrator", "Manager"]}>
              <GreenhousePage />
            </RequireRole>
          }
        />
        <Route path="inputs" element={<InputsPage />} />
        <Route
          path="reports"
          element={
            <RequireRole roles={["Administrator", "Manager"]}>
              <ReportsPage />
            </RequireRole>
          }
        />
        <Route
          path="reports/:id"
          element={
            <RequireRole roles={["Administrator", "Manager"]}>
              <ReportViewPage />
            </RequireRole>
          }
        />
        <Route path="employees" element={<EmployeesPage />} />
        <Route path="activities/*" element={<ActivitiesPage />} />
        <Route path="basic-data/*" element={<BasicDataPage />} />
        <Route path="devices" element={<DevicesPage />} />
        <Route path="setup/*" element={<SetupPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/inputs" replace />} />
      </Route>
    </Routes>
  );
}

function MobileApp() {
  const { status } = useDevicePairing();

  // Brief, one-time window at boot while local storage (and, if needed, its
  // IndexedDB backup) is read — see DevicePairingContext. Deliberately not
  // the pairing screen: that screen's own mount effect immediately starts a
  // new pairing request, which a device that's actually still validly
  // paired must never trigger just because recovery hasn't resolved yet.
  if (status === "checking") {
    return <p className="centered-message">Loading...</p>;
  }

  if (status === "unpaired") {
    return <PairingScreen />;
  }

  return (
    <Routes>
      <Route path="/mobile" element={<MobileLayout />}>
        <Route index element={<Navigate to="/mobile/home" replace />} />
        <Route path="home" element={<HomeScreen />} />
        <Route path="stats" element={<StatsScreen />} />
        <Route path="settings" element={<SettingsScreen />} />
        <Route path="*" element={<Navigate to="/mobile/home" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/mobile" replace />} />
    </Routes>
  );
}

export default function App() {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <DevicePairingProvider>
        <MobileApp />
      </DevicePairingProvider>
    );
  }

  return (
    <AuthProvider>
      <DesktopApp />
    </AuthProvider>
  );
}
