import { useCallback, useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import { ActivityGroup, ActivityGroupDetail } from "../../lib/activityTypes";
import { Employee } from "../../lib/employeeTypes";

interface AssignEmployeesModalProps {
  group: ActivityGroup;
  onClose: () => void;
  onChanged: () => void;
}

export function AssignEmployeesModal({ group, onClose, onChanged }: AssignEmployeesModalProps) {
  const [detail, setDetail] = useState<ActivityGroupDetail | null>(null);
  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    Promise.all([
      api<{ activityGroup: ActivityGroupDetail }>(`/api/activity-groups/${group.id}`),
      api<{ employees: Employee[] }>("/api/employees?status=active"),
    ])
      .then(([groupRes, empRes]) => {
        setDetail(groupRes.activityGroup);
        setEmployees(empRes.employees);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "Could not load assignment data");
      });
  }, [group.id]);

  useEffect(() => {
    load();
  }, [load]);

  function toggleSelected(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleRemove(employeeId: string) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/employees/${employeeId}/activity-group`, {
        method: "PATCH",
        body: JSON.stringify({ activityGroupId: null }),
      });
      load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove employee from group");
    } finally {
      setBusy(false);
    }
  }

  async function handleAssign() {
    if (selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/activity-groups/${group.id}/assign-employees`, {
        method: "POST",
        body: JSON.stringify({ employeeIds: [...selected] }),
      });
      setSelected(new Set());
      load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not assign employees to this group");
    } finally {
      setBusy(false);
    }
  }

  const assignedIds = new Set(detail?.assignedEmployees.map((e) => e.id) ?? []);
  const candidates = employees?.filter((e) => !assignedIds.has(e.id)) ?? [];

  return (
    <Modal title={`Assign Employees — ${group.name}`} onClose={onClose} wide>
      {error && <p className="error-text">{error}</p>}

      <section className="employee-form-section">
        <h3>Currently assigned</h3>
        {!detail ? (
          <p>Loading...</p>
        ) : detail.assignedEmployees.length === 0 ? (
          <p className="placeholder-page">No employees are currently assigned to this group.</p>
        ) : (
          <ul className="activity-checklist">
            {detail.assignedEmployees.map((e) => (
              <li key={e.id} className="activity-checklist-item">
                <span>
                  {e.firstName} {e.lastName}
                </span>
                <button type="button" disabled={busy} onClick={() => handleRemove(e.id)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="employee-form-section">
        <h3>Add employees</h3>
        {!employees ? (
          <p>Loading...</p>
        ) : candidates.length === 0 ? (
          <p className="placeholder-page">No other active employees available to add.</p>
        ) : (
          <div className="activity-checklist">
            {candidates.map((e) => (
              <label key={e.id} className="activity-checklist-item">
                <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggleSelected(e.id)} />
                {e.firstName} {e.lastName}
                {e.activityGroup && (
                  <span className="field-error"> (currently: {e.activityGroup.name})</span>
                )}
              </label>
            ))}
          </div>
        )}
      </section>

      <div className="employee-form-actions">
        <button type="button" onClick={onClose}>
          Close
        </button>
        <button type="button" className="employee-form-save" disabled={busy || selected.size === 0} onClick={handleAssign}>
          {busy ? "Assigning..." : `Assign ${selected.size || ""}`.trim()}
        </button>
      </div>
    </Modal>
  );
}
