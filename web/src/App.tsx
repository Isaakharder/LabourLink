import { Navigate, Route, Routes } from "react-router-dom";
import { DesktopLayout } from "./components/desktop/DesktopLayout";
import { MobileLayout } from "./components/mobile/MobileLayout";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { EmployeesPage } from "./pages/desktop/EmployeesPage";
import { InputsPage } from "./pages/desktop/InputsPage";
import { LoginPage } from "./pages/desktop/LoginPage";
import { SetupPage } from "./pages/desktop/SetupPage";
import { HomeScreen } from "./pages/mobile/HomeScreen";
import { PairingScreen } from "./pages/mobile/PairingScreen";
import { SettingsScreen } from "./pages/mobile/SettingsScreen";
import { SyncScreen } from "./pages/mobile/SyncScreen";
import { useIsMobile } from "./lib/useIsMobile";

function DesktopApp() {
  const { employee, loading } = useAuth();

  if (loading) return <p className="centered-message">Loading...</p>;
  if (!employee) return <LoginPage />;

  return (
    <Routes>
      <Route element={<DesktopLayout />}>
        <Route index element={<Navigate to="/inputs" replace />} />
        <Route path="inputs" element={<InputsPage />} />
        <Route path="employees" element={<EmployeesPage />} />
        <Route path="setup" element={<SetupPage />} />
        <Route path="*" element={<Navigate to="/inputs" replace />} />
      </Route>
    </Routes>
  );
}

// Not paired yet == no device_identifier saved locally. Real pairing status
// checks against the server land in Phase 3; for now this only decides which
// shell screen to show.
function isPaired(): boolean {
  return Boolean(localStorage.getItem("labourlink_device_identifier"));
}

function MobileApp() {
  if (!isPaired()) {
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
    return <MobileApp />;
  }

  return (
    <AuthProvider>
      <DesktopApp />
    </AuthProvider>
  );
}
