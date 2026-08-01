import { Navigate, Route, Routes, useLocation, useSearchParams } from "react-router-dom";
import { AppLayout } from "./components/layout/AppLayout";
import { MobileLayout } from "./components/mobile/MobileLayout";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { DevicePairingProvider, useDevicePairing } from "./context/DevicePairingContext";
import { DashboardPage } from "./pages/desktop/DashboardPage";
import { DevicesPage } from "./pages/desktop/DevicesPage";
import { EmployeesPage } from "./pages/desktop/EmployeesPage";
import { InputsPage } from "./pages/desktop/InputsPage";
import { LoginPage } from "./pages/desktop/LoginPage";
import { ResetPinPage } from "./pages/desktop/ResetPinPage";
import { SettingsPage } from "./pages/desktop/SettingsPage";
import { SetupPage } from "./pages/desktop/SetupPage";
import { HomeScreen } from "./pages/mobile/HomeScreen";
import { PairingScreen } from "./pages/mobile/PairingScreen";
import { SettingsScreen } from "./pages/mobile/SettingsScreen";
import { SyncScreen } from "./pages/mobile/SyncScreen";
import { useIsMobile } from "./lib/useIsMobile";

function DesktopApp() {
  const { employee, loading } = useAuth();
  const location = useLocation();
  const [searchParams] = useSearchParams();

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
        <Route path="inputs" element={<InputsPage />} />
        <Route path="employees" element={<EmployeesPage />} />
        <Route path="devices" element={<DevicesPage />} />
        <Route path="setup" element={<SetupPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/inputs" replace />} />
      </Route>
    </Routes>
  );
}

function MobileApp() {
  const { paired } = useDevicePairing();

  if (!paired) {
    return <PairingScreen />;
  }

  return (
    <Routes>
      <Route path="/mobile" element={<MobileLayout />}>
        <Route index element={<Navigate to="/mobile/home" replace />} />
        <Route path="home" element={<HomeScreen />} />
        <Route path="sync" element={<SyncScreen />} />
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
