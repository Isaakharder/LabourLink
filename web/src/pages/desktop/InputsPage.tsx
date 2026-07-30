import { useEffect, useState } from "react";
import { PageHeader } from "../../components/layout/PageHeader";
import { api } from "../../lib/api";

interface DashboardStats {
  totalEmployees: number;
  totalDevices: number;
  assignedDevices: number;
  unassignedDevices: number;
  devicesWaitingForSetup: number;
}

export function InputsPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<DashboardStats>("/api/dashboard")
      .then(setStats)
      .catch(() => setError("Could not load dashboard stats"));
  }, []);

  const tiles: Array<[string, number]> | null = stats
    ? [
        ["Total Employees", stats.totalEmployees],
        ["Total Devices", stats.totalDevices],
        ["Assigned Devices", stats.assignedDevices],
        ["Unassigned Devices", stats.unassignedDevices],
        ["Devices Waiting For Setup", stats.devicesWaitingForSetup],
      ]
    : null;

  return (
    <>
      <PageHeader title="Inputs" />
      {error && <p className="error-text">{error}</p>}
      {!error && !tiles && <p>Loading...</p>}
      {tiles && (
        <div className="stat-grid">
          {tiles.map(([label, value]) => (
            <div className="stat-tile" key={label}>
              <span className="stat-value">{value}</span>
              <span className="stat-label">{label}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
