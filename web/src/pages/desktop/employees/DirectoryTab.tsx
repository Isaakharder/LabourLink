import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  Pencil,
  Power,
  Smartphone,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Avatar } from "../../../components/employees/Avatar";
import { EmployeeFormModal } from "../../../components/employees/EmployeeFormModal";
import { WorkPermitStatus } from "../../../components/employees/WorkPermitStatus";
import { api, ApiError } from "../../../lib/api";
import { Employee } from "../../../lib/employeeTypes";
import { useAuth } from "../../../context/AuthContext";

type StatusFilter = "active" | "inactive" | "all";

interface EmployeeDeviceAssignment {
  id: string;
  deviceName: string | null;
  datePaired: string | null;
  employeeId: string | null;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function DirectoryTab() {
  const navigate = useNavigate();
  const { employee: currentEmployee } = useAuth();
  const isAdmin = currentEmployee?.securityRole === "Administrator";

  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [jobGroups, setJobGroups] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [nationality, setNationality] = useState<string>("all");
  const [jobGroup, setJobGroup] = useState<string>("all");

  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null);
  const [selectedEmployeeDetail, setSelectedEmployeeDetail] = useState<Employee | null>(null);
  const [selectedDetailLoading, setSelectedDetailLoading] = useState(false);
  const [detailRefreshKey, setDetailRefreshKey] = useState(0);
  const [deviceAssignments, setDeviceAssignments] = useState<Record<string, EmployeeDeviceAssignment>>({});

  const [modalEmployee, setModalEmployee] = useState<Employee | null | "new">(null);
  const detailRequestIdRef = useRef(0);

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

  const loadDeviceAssignments = useCallback(() => {
    api<{
      devices: Array<{
        id: string;
        device_name: string | null;
        date_paired: string | null;
        employee_id: string | null;
      }>;
    }>("/api/devices")
      .then((res) => {
        const next: Record<string, EmployeeDeviceAssignment> = {};
        for (const device of res.devices) {
          if (!device.employee_id) continue;
          next[device.employee_id] = {
            id: device.id,
            deviceName: device.device_name,
            datePaired: device.date_paired,
            employeeId: device.employee_id,
          };
        }
        setDeviceAssignments(next);
      })
      .catch(() => setDeviceAssignments({}));
  }, []);

  useEffect(() => {
    const t = window.setTimeout(load, search ? 300 : 0); // debounce free-text search only
    return () => window.clearTimeout(t);
  }, [load, search]);

  useEffect(() => {
    loadDeviceAssignments();
  }, [loadDeviceAssignments]);

  useEffect(() => {
    if (!employees || employees.length === 0) {
      setSelectedEmployeeId(null);
      setSelectedEmployeeDetail(null);
      return;
    }

    if (!selectedEmployeeId || !employees.some((emp) => emp.id === selectedEmployeeId)) {
      setSelectedEmployeeId(employees[0].id);
    }
  }, [employees, selectedEmployeeId]);

  useEffect(() => {
    if (!selectedEmployeeId) {
      setSelectedEmployeeDetail(null);
      setDetailError(null);
      return;
    }

    const requestId = ++detailRequestIdRef.current;
    setSelectedDetailLoading(true);
    setDetailError(null);

    api<{ employee: Employee }>(`/api/employees/${selectedEmployeeId}`)
      .then((res) => {
        if (detailRequestIdRef.current !== requestId) return;
        setSelectedEmployeeDetail(res.employee);
      })
      .catch((err) => {
        if (detailRequestIdRef.current !== requestId) return;
        setDetailError(err instanceof ApiError ? err.message : "Could not load employee details");
      })
      .finally(() => {
        if (detailRequestIdRef.current === requestId) setSelectedDetailLoading(false);
      });
  }, [selectedEmployeeId, detailRefreshKey]);

  const selectedEmployeeSummary = useMemo(
    () => employees?.find((emp) => emp.id === selectedEmployeeId) ?? null,
    [employees, selectedEmployeeId]
  );

  const selectedEmployee = selectedEmployeeDetail?.id === selectedEmployeeId ? selectedEmployeeDetail : selectedEmployeeSummary;
  const selectedDeviceAssignment = selectedEmployee ? deviceAssignments[selectedEmployee.id] ?? null : null;

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
      setDetailRefreshKey((value) => value + 1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update employee");
    }
  }

  return (
    <>
      <div className="employees-page">
        <div className="employees-toolbar">
          <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="all">All</option>
          </select>

          <select value={nationality} onChange={(e) => setNationality(e.target.value)}>
            <option value="all">All nationalities</option>
            <option value="Canadian">Canadian</option>
            <option value="Mexican">Mexican</option>
            <option value="Jamaican">Jamaican</option>
            <option value="Guatemalan">Guatemalan</option>
            <option value="Filipino">Filipino</option>
            <option value="Thai">Thai</option>
          </select>

          <select value={jobGroup} onChange={(e) => setJobGroup(e.target.value)}>
            <option value="all">All job groups</option>
            {jobGroups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>

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
          <div className="employees-empty-state">
            <p className="placeholder-page">No employees match these filters.</p>
          </div>
        ) : (
          <div className="employees-master-detail">
            <section className="employees-list-panel">
              <div className="employees-list-card">
                <div className="employees-list-card-header">
                  <input
                    type="search"
                    placeholder="Search employees"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="employees-search employees-list-search"
                  />
                  <p className="employees-list-count">{employees.length} visible</p>
                </div>

                <div className="employees-list-scroll">
                  <ul className="employees-list-items">
                    {employees.map((emp) => {
                      const isSelected = emp.id === selectedEmployeeId;
                      return (
                        <li key={emp.id}>
                          <button
                            type="button"
                            className={`employees-list-item${isSelected ? " employees-list-item-selected" : ""}`}
                            onClick={() => setSelectedEmployeeId(emp.id)}
                          >
                            <Avatar photoUrl={emp.photoUrl} firstName={emp.firstName} lastName={emp.lastName} />
                            <div className="employees-list-item-body">
                              <div className="employees-list-item-topline">
                                <span className="employees-list-item-name">
                                  {emp.firstName} {emp.lastName}
                                </span>
                                <span className={`status-pill ${emp.isActive ? "status-active" : "status-inactive"}`}>
                                  {emp.isActive ? "Active" : "Inactive"}
                                </span>
                              </div>
                            </div>
                            <ChevronRight size={18} className="employees-list-item-chevron" aria-hidden="true" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>
            </section>

            <section className="employees-detail-panel">
              {selectedEmployee ? (
                <div className="employees-detail-scroll">
                  <div className="employees-detail-hero">
                    <div className="employees-detail-hero-main">
                      <Avatar
                        photoUrl={selectedEmployee.photoUrl}
                        firstName={selectedEmployee.firstName}
                        lastName={selectedEmployee.lastName}
                        size="large"
                      />
                      <div className="employees-detail-hero-copy">
                        <div className="employees-detail-hero-title-row">
                          <h2>
                            {selectedEmployee.firstName} {selectedEmployee.lastName}
                          </h2>
                          <span className={`status-pill ${selectedEmployee.isActive ? "status-active" : "status-inactive"}`}>
                            {selectedEmployee.isActive ? "Active" : "Inactive"}
                          </span>
                        </div>
                        <div className="employees-detail-hero-meta">
                          <span>{selectedEmployee.nationality}</span>
                          <span>{selectedEmployee.jobGroup ?? "No job group"}</span>
                          <span>
                            {selectedEmployee.activityGroups.length === 0
                              ? "No activity groups"
                              : selectedEmployee.activityGroups.length <= 2
                                ? selectedEmployee.activityGroups.map((g) => g.name).join(", ")
                                : `${selectedEmployee.activityGroups.length} activity groups`}
                          </span>
                        </div>
                        <div className="employees-detail-hero-contact">
                          <span>{selectedEmployee.email ?? "No email"}</span>
                        </div>
                        {selectedDetailLoading && <p className="employees-detail-loading">Refreshing details…</p>}
                        {detailError && <p className="error-text">{detailError}</p>}
                      </div>
                    </div>

                    {isAdmin && (
                      <div className="employees-detail-hero-actions">
                        <button type="button" className="employees-detail-button" onClick={() => setModalEmployee(selectedEmployee)}>
                          <Pencil size={16} aria-hidden="true" />
                          <span>Edit Employee</span>
                        </button>
                        <button type="button" className="employees-detail-button" onClick={() => handleToggleActive(selectedEmployee)}>
                          <Power size={16} aria-hidden="true" />
                          <span>{selectedEmployee.isActive ? "Deactivate" : "Activate"}</span>
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="employees-detail-card-grid">
                    <section className="employees-detail-card">
                      <h3>Personal Information</h3>
                      <dl className="employees-detail-list">
                        <div>
                          <dt>Employee #</dt>
                          <dd>{selectedEmployee.employeeNumber ?? "—"}</dd>
                        </div>
                        <div>
                          <dt>Phone</dt>
                          <dd>{selectedEmployee.phoneNumber ?? "—"}</dd>
                        </div>
                        <div>
                          <dt>Email</dt>
                          <dd>{selectedEmployee.email ?? "—"}</dd>
                        </div>
                        <div>
                          <dt>Nationality</dt>
                          <dd>{selectedEmployee.nationality}</dd>
                        </div>
                        <div>
                          <dt>Date of Birth</dt>
                          <dd>{formatDate(selectedEmployee.dateOfBirth)}</dd>
                        </div>
                        <div>
                          <dt>Gender</dt>
                          <dd>{selectedEmployee.gender ?? "—"}</dd>
                        </div>
                        <div>
                          <dt>Work Start Date</dt>
                          <dd>{formatDate(selectedEmployee.startDate)}</dd>
                        </div>
                        <div>
                          <dt>Work Permit</dt>
                          <dd>
                            <WorkPermitStatus employee={selectedEmployee} />
                          </dd>
                        </div>
                      </dl>
                    </section>

                    <section className="employees-detail-card">
                      <h3>Job Information</h3>
                      <dl className="employees-detail-list">
                        <div>
                          <dt>Job Group</dt>
                          <dd>{selectedEmployee.jobGroup ?? "—"}</dd>
                        </div>
                        <div>
                          <dt>Activity Groups</dt>
                          <dd>{selectedEmployee.activityGroups.length > 0 ? selectedEmployee.activityGroups.map((group) => group.name).join(", ") : "—"}</dd>
                        </div>
                        <div>
                          <dt>Team Role</dt>
                          <dd>{selectedEmployee.teamRole ?? "—"}</dd>
                        </div>
                        <div>
                          <dt>Break Profile</dt>
                          <dd>{selectedEmployee.breakProfile?.name ?? "—"}</dd>
                        </div>
                        <div>
                          <dt>Security Role</dt>
                          <dd>{selectedEmployee.securityRole ?? "—"}</dd>
                        </div>
                      </dl>
                    </section>

                    <section className="employees-detail-card">
                      <h3>Device Assignment</h3>
                      <dl className="employees-detail-list">
                        <div>
                          <dt>Assigned device</dt>
                          <dd>{selectedEmployee.device?.name ?? selectedDeviceAssignment?.deviceName ?? "—"}</dd>
                        </div>
                        <div>
                          <dt>Device/app role</dt>
                          <dd>{selectedEmployee.device ? "—" : "—"}</dd>
                        </div>
                        <div>
                          <dt>Paired date</dt>
                          <dd>{formatDateTime(selectedDeviceAssignment?.datePaired)}</dd>
                        </div>
                      </dl>
                      {isAdmin && (
                        <button type="button" className="employees-detail-button employees-detail-button-secondary" onClick={() => navigate("/setup") }>
                          <Smartphone size={16} aria-hidden="true" />
                          <span>Manage Device</span>
                        </button>
                      )}
                    </section>

                    <section className="employees-detail-card">
                      <h3>Status &amp; History</h3>
                      <dl className="employees-detail-list">
                        <div>
                          <dt>Status</dt>
                          <dd>{selectedEmployee.isActive ? "Active" : "Inactive"}</dd>
                        </div>
                        <div>
                          <dt>Created</dt>
                          <dd>{formatDateTime(selectedEmployee.createdAt)}</dd>
                        </div>
                        <div>
                          <dt>Updated</dt>
                          <dd>{formatDateTime(selectedEmployee.updatedAt)}</dd>
                        </div>
                      </dl>
                    </section>
                  </div>

                  {selectedEmployee.notes && (
                    <section className="employees-detail-card employees-detail-card-notes">
                      <h3>Notes</h3>
                      <p>{selectedEmployee.notes}</p>
                    </section>
                  )}
                </div>
              ) : (
                <div className="employees-empty-state employees-empty-state-detail">
                  <p className="placeholder-page">Select an employee to view details.</p>
                </div>
              )}
            </section>
          </div>
        )}
      </div>

      {modalEmployee && (
        <EmployeeFormModal
          employee={modalEmployee === "new" ? null : modalEmployee}
          onClose={() => setModalEmployee(null)}
          onSaved={() => {
            setModalEmployee(null);
            load();
            loadDeviceAssignments();
            setDetailRefreshKey((value) => value + 1);
          }}
        />
      )}
    </>
  );
}
