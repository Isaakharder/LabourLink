import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../../lib/api";
import { ActivityGroup } from "../../../lib/activityTypes";
import { useAuth } from "../../../context/AuthContext";
import { ActivityGroupFormModal } from "../../../components/activities/ActivityGroupFormModal";
import { AssignEmployeesModal } from "../../../components/activities/AssignEmployeesModal";

type StatusFilter = "active" | "inactive" | "all";

function summarizeActivities(group: ActivityGroup): string {
  if (group.activities.length === 0) return "—";
  const names = group.activities.map((a) => a.name);
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} +${names.length - 3} more`;
}

export function ActivityGroupsTab() {
  const { employee: currentEmployee } = useAuth();
  const isAdmin = currentEmployee?.securityRole === "Administrator";

  const [groups, setGroups] = useState<ActivityGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");

  const [modalGroup, setModalGroup] = useState<ActivityGroup | null | "new">(null);
  const [assignGroup, setAssignGroup] = useState<ActivityGroup | null>(null);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    params.set("status", status);

    api<{ activityGroups: ActivityGroup[] }>(`/api/activity-groups?${params.toString()}`)
      .then((res) => {
        setGroups(res.activityGroups);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "Could not load activity groups");
      });
  }, [search, status]);

  useEffect(() => {
    const t = window.setTimeout(load, search ? 300 : 0);
    return () => window.clearTimeout(t);
  }, [load, search]);

  async function handleToggleActive(group: ActivityGroup) {
    if (group.isActive) {
      const warning =
        group.assignedEmployeeCount > 0
          ? `${group.assignedEmployeeCount} employee${group.assignedEmployeeCount === 1 ? "" : "s"} currently assigned to "${group.name}" will lose access to its activities immediately. `
          : "";
      const proceed = window.confirm(`${warning}Deactivate "${group.name}"? Assignment history is preserved.`);
      if (!proceed) return;
    }
    try {
      await api(`/api/activity-groups/${group.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !group.isActive }),
      });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update activity group");
    }
  }

  function renderActions(group: ActivityGroup) {
    if (!isAdmin) return null;
    return (
      <div className="employee-row-actions">
        <button type="button" onClick={() => setModalGroup(group)}>
          Edit
        </button>
        <button type="button" onClick={() => setAssignGroup(group)}>
          Assign Employees
        </button>
        <button type="button" onClick={() => handleToggleActive(group)}>
          {group.isActive ? "Deactivate" : "Activate"}
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="employees-toolbar">
        <input
          type="search"
          placeholder="Search by group name"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="employees-search"
        />

        <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="all">All</option>
        </select>

        <span className="employees-count">
          {groups ? `${groups.length} group${groups.length === 1 ? "" : "s"}` : ""}
        </span>

        {isAdmin && (
          <button type="button" className="employees-add-button" onClick={() => setModalGroup("new")}>
            Add Activity Group
          </button>
        )}
      </div>

      {error && <p className="error-text">{error}</p>}

      {!groups ? (
        <p>Loading...</p>
      ) : groups.length === 0 ? (
        <p className="placeholder-page">No activity groups match these filters.</p>
      ) : (
        <>
          <table className="employees-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Description</th>
                <th>Activities</th>
                <th>Employees</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.id}>
                  <td>{g.name}</td>
                  <td>{g.description ?? "—"}</td>
                  <td>
                    {g.activityCount} — {summarizeActivities(g)}
                  </td>
                  <td>{g.assignedEmployeeCount}</td>
                  <td>
                    <span className={`status-pill ${g.isActive ? "status-active" : "status-inactive"}`}>
                      {g.isActive ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td>{renderActions(g)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="employee-cards">
            {groups.map((g) => (
              <div className="employee-card" key={g.id}>
                <div className="employee-card-header">
                  <div>
                    <div className="employee-card-name">{g.name}</div>
                    <span className={`status-pill ${g.isActive ? "status-active" : "status-inactive"}`}>
                      {g.isActive ? "Active" : "Inactive"}
                    </span>
                  </div>
                </div>
                <dl className="employee-card-fields">
                  <div>
                    <dt>Description</dt>
                    <dd>{g.description ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Activities</dt>
                    <dd>
                      {g.activityCount} — {summarizeActivities(g)}
                    </dd>
                  </div>
                  <div>
                    <dt>Employees</dt>
                    <dd>{g.assignedEmployeeCount}</dd>
                  </div>
                </dl>
                {renderActions(g)}
              </div>
            ))}
          </div>
        </>
      )}

      {modalGroup && (
        <ActivityGroupFormModal
          group={modalGroup === "new" ? null : modalGroup}
          onClose={() => setModalGroup(null)}
          onSaved={() => {
            setModalGroup(null);
            load();
          }}
        />
      )}

      {assignGroup && (
        <AssignEmployeesModal group={assignGroup} onClose={() => setAssignGroup(null)} onChanged={load} />
      )}
    </>
  );
}
