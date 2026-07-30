import { FormEvent, useCallback, useEffect, useState } from "react";
import { PageHeader } from "../../components/layout/PageHeader";
import { api, ApiError } from "../../lib/api";

interface PairingRequest {
  id: string;
  pairing_code: string;
  device_identifier: string;
  created_at: string;
  expires_at: string;
}

interface Device {
  id: string;
  device_name: string | null;
  is_active: boolean;
  last_seen: string | null;
  date_paired: string | null;
  employee_id: string | null;
  first_name: string | null;
  last_name: string | null;
}

interface Employee {
  id: string;
  first_name: string;
  last_name: string;
}

const POLL_INTERVAL_MS = 5000;

export function SetupPage() {
  const [requests, setRequests] = useState<PairingRequest[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState<string | null>(null);
  const [deviceNameDrafts, setDeviceNameDrafts] = useState<Record<string, string>>({});
  const [employeeDrafts, setEmployeeDrafts] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    Promise.all([
      api<{ requests: PairingRequest[] }>("/api/devices/pairing-requests"),
      api<{ devices: Device[] }>("/api/devices"),
      api<{ employees: Employee[] }>("/api/employees"),
    ])
      .then(([r, d, e]) => {
        setRequests(r.requests);
        setDevices(d.devices);
        setEmployees(e.employees);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "Could not load Setup data");
      });
  }, []);

  useEffect(() => {
    load();
    const interval = window.setInterval(load, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [load]);

  async function handleApprove(e: FormEvent, requestId: string) {
    e.preventDefault();
    const deviceName = deviceNameDrafts[requestId]?.trim();
    const employeeId = employeeDrafts[requestId];
    if (!deviceName || !employeeId) {
      setError("Enter a device name and choose an employee before approving.");
      return;
    }
    setApproving(requestId);
    setError(null);
    try {
      await api(`/api/devices/pairing-requests/${requestId}/approve`, {
        method: "POST",
        body: JSON.stringify({ deviceName, employeeId }),
      });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not approve this device");
    } finally {
      setApproving(null);
    }
  }

  async function handleDeactivate(deviceId: string) {
    try {
      await api(`/api/devices/${deviceId}/deactivate`, { method: "POST" });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not deactivate this device");
    }
  }

  return (
    <>
      <PageHeader title="Setup" description="Pair phones and manage device assignments." />
      {error && <p className="error-text">{error}</p>}

      <section className="setup-section">
        <h2>Pending pairing requests</h2>
        {requests.length === 0 ? (
          <p className="placeholder-page">No devices are waiting to be paired.</p>
        ) : (
          <div className="setup-card-list">
            {requests.map((r) => (
              <form
                key={r.id}
                className="setup-card"
                onSubmit={(e) => handleApprove(e, r.id)}
              >
                <div className="setup-card-code">{r.pairing_code}</div>
                <label>
                  Device name
                  <input
                    type="text"
                    placeholder="e.g. Field Phone 1"
                    value={deviceNameDrafts[r.id] ?? ""}
                    onChange={(e) =>
                      setDeviceNameDrafts((d) => ({ ...d, [r.id]: e.target.value }))
                    }
                    required
                  />
                </label>
                <label>
                  Assign employee
                  <select
                    value={employeeDrafts[r.id] ?? ""}
                    onChange={(e) =>
                      setEmployeeDrafts((d) => ({ ...d, [r.id]: e.target.value }))
                    }
                    required
                  >
                    <option value="" disabled>
                      Choose employee...
                    </option>
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {emp.first_name} {emp.last_name}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" disabled={approving === r.id}>
                  {approving === r.id ? "Approving..." : "Approve"}
                </button>
              </form>
            ))}
          </div>
        )}
      </section>

      <section className="setup-section">
        <h2>Devices</h2>
        {devices.length === 0 ? (
          <p className="placeholder-page">No devices paired yet.</p>
        ) : (
          <table className="setup-table">
            <thead>
              <tr>
                <th>Device</th>
                <th>Assigned to</th>
                <th>Status</th>
                <th>Last seen</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id}>
                  <td>{d.device_name}</td>
                  <td>{d.first_name ? `${d.first_name} ${d.last_name}` : "Unassigned"}</td>
                  <td>{d.is_active ? "Active" : "Deactivated"}</td>
                  <td>{d.last_seen ? new Date(d.last_seen).toLocaleString() : "Never"}</td>
                  <td>
                    {d.is_active && (
                      <button type="button" onClick={() => handleDeactivate(d.id)}>
                        Deactivate
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
