import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "../../components/layout/PageHeader";
import { Avatar } from "../../components/employees/Avatar";
import { EmployeeFormModal } from "../../components/employees/EmployeeFormModal";
import { api, ApiError } from "../../lib/api";
import { Employee } from "../../lib/employeeTypes";
import { useAuth } from "../../context/AuthContext";

type StatusFilter = "active" | "inactive" | "all";

export function EmployeesPage() {
  const { employee: currentEmployee } = useAuth();
  const isAdmin = currentEmployee?.securityRole === "Administrator";

  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [jobGroups, setJobGroups] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [nationality, setNationality] = useState<string>("all");
  const [jobGroup, setJobGroup] = useState<string>("all");

  const [modalEmployee, setModalEmployee] = useState<Employee | null | "new">(null);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    params.set("status", status);
    if (nationality !== "all") params.set("nationality", nationality);
    if (jobGroup !== "all") params.set("jobGroup", jobGroup);

    api<{ employees: Employee[]; jobGroups: string[] }>(`/api/employees?${params.toString()}`)
      .then((res) => {
        setEmployees(res.employees);
        setJobGroups(res.jobGroups);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "Could not load employees");
      });
  }, [search, status, nationality, jobGroup]);

  useEffect(() => {
    const t = window.setTimeout(load, search ? 300 : 0); // debounce free-text search only
    return () => window.clearTimeout(t);
  }, [load, search]);

  async function handleToggleActive(emp: Employee) {
    if (emp.isActive && emp.device) {
      const proceed = window.confirm(
        `${emp.firstName} ${emp.lastName} has an assigned device (${
          emp.device.name ?? "unnamed"
        }). Deactivating will end that assignment — the device itself stays paired and can be reassigned. Deactivate anyway?`
      );
      if (!proceed) return;
    }
    try {
      await api(`/api/employees/${emp.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !emp.isActive }),
      });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update employee");
    }
  }

  function renderActions(emp: Employee) {
    if (!isAdmin) return null;
    return (
      <div className="employee-row-actions">
        <button type="button" onClick={() => setModalEmployee(emp)}>
          Edit
        </button>
        <button type="button" onClick={() => handleToggleActive(emp)}>
          {emp.isActive ? "Deactivate" : "Activate"}
        </button>
      </div>
    );
  }

  return (
    <>
      <PageHeader title="Employees" description="Manage employee profiles and device assignments." />

      <div className="employees-toolbar">
        <input
          type="search"
          placeholder="Search by name, employee #, or email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="employees-search"
        />

        <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="all">All</option>
        </select>

        <select value={nationality} onChange={(e) => setNationality(e.target.value)}>
          <option value="all">All nationalities</option>
          <option value="Canadian">Canadian</option>
          <option value="Mexican">Mexican</option>
        </select>

        <select value={jobGroup} onChange={(e) => setJobGroup(e.target.value)}>
          <option value="all">All job groups</option>
          {jobGroups.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>

        <span className="employees-count">
          {employees ? `${employees.length} employee${employees.length === 1 ? "" : "s"}` : ""}
        </span>

        {isAdmin && (
          <button type="button" className="employees-add-button" onClick={() => setModalEmployee("new")}>
            Add employee
          </button>
        )}
      </div>

      {error && <p className="error-text">{error}</p>}

      {!employees ? (
        <p>Loading...</p>
      ) : employees.length === 0 ? (
        <p className="placeholder-page">No employees match these filters.</p>
      ) : (
        <>
          <table className="employees-table">
            <thead>
              <tr>
                <th></th>
                <th>Name</th>
                <th>Employee #</th>
                <th>Nationality</th>
                <th>Job group</th>
                <th>Phone</th>
                <th>Email</th>
                <th>Start date</th>
                <th>Status</th>
                <th>Device</th>
                <th>Activity Group</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {employees.map((emp) => (
                <tr key={emp.id}>
                  <td>
                    <Avatar photoUrl={emp.photoUrl} firstName={emp.firstName} lastName={emp.lastName} />
                  </td>
                  <td>
                    {emp.firstName} {emp.lastName}
                  </td>
                  <td>{emp.employeeNumber ?? "—"}</td>
                  <td>{emp.nationality}</td>
                  <td>{emp.jobGroup ?? "—"}</td>
                  <td>{emp.phoneNumber ?? "—"}</td>
                  <td>{emp.email ?? "—"}</td>
                  <td>{emp.startDate}</td>
                  <td>
                    <span className={`status-pill ${emp.isActive ? "status-active" : "status-inactive"}`}>
                      {emp.isActive ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td>{emp.device ? emp.device.name ?? "Unnamed device" : "—"}</td>
                  <td>{emp.activityGroup?.name ?? "No activity group"}</td>
                  <td>{renderActions(emp)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="employee-cards">
            {employees.map((emp) => (
              <div className="employee-card" key={emp.id}>
                <div className="employee-card-header">
                  <Avatar photoUrl={emp.photoUrl} firstName={emp.firstName} lastName={emp.lastName} />
                  <div>
                    <div className="employee-card-name">
                      {emp.firstName} {emp.lastName}
                    </div>
                    <span className={`status-pill ${emp.isActive ? "status-active" : "status-inactive"}`}>
                      {emp.isActive ? "Active" : "Inactive"}
                    </span>
                  </div>
                </div>
                <dl className="employee-card-fields">
                  <div>
                    <dt>Employee #</dt>
                    <dd>{emp.employeeNumber ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Nationality</dt>
                    <dd>{emp.nationality}</dd>
                  </div>
                  <div>
                    <dt>Job group</dt>
                    <dd>{emp.jobGroup ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Phone</dt>
                    <dd>{emp.phoneNumber ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Email</dt>
                    <dd>{emp.email ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Start date</dt>
                    <dd>{emp.startDate}</dd>
                  </div>
                  <div>
                    <dt>Device</dt>
                    <dd>{emp.device ? emp.device.name ?? "Unnamed device" : "—"}</dd>
                  </div>
                  <div>
                    <dt>Activity Group</dt>
                    <dd>{emp.activityGroup?.name ?? "No activity group"}</dd>
                  </div>
                </dl>
                {renderActions(emp)}
              </div>
            ))}
          </div>
        </>
      )}

      {modalEmployee && (
        <EmployeeFormModal
          employee={modalEmployee === "new" ? null : modalEmployee}
          onClose={() => setModalEmployee(null)}
          onSaved={() => {
            setModalEmployee(null);
            load();
          }}
        />
      )}
    </>
  );
}
