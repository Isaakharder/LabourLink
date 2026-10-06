import { FormEvent, useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import { api, ApiError } from "../../../lib/api";
import { useAuth } from "../../../context/AuthContext";
import { EmployeeGroup, EmployeeGroupsResponse, UNGROUPED_LABEL } from "../../../lib/employeeGroupTypes";

// Employees > Employee Groups: create, rename and delete the groups that
// organize the employee list (Inputs sidebar headings). Assigning employees
// happens on the employee's own Add/Edit form. Same permission split as the
// rest of employee management: Administrators edit, Managers view.

// The server's own name error (blank, too long, duplicate) when there is one.
function fieldError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.errors?.name ?? err.message ?? fallback;
  return fallback;
}

function countLabel(total: number, active: number): string {
  const inactive = total - active;
  return `${active} employee${active === 1 ? "" : "s"}${inactive > 0 ? ` · ${inactive} inactive` : ""}`;
}

export function EmployeeGroupsTab() {
  const { employee: currentEmployee } = useAuth();
  const isAdmin = currentEmployee?.securityRole === "Administrator";

  const [data, setData] = useState<EmployeeGroupsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<EmployeeGroup | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    return api<EmployeeGroupsResponse>("/api/employee-groups")
      .then((res) => {
        setData(res);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Could not load employee groups"));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (creating) return;
    const name = newName.trim();
    if (!name) {
      setCreateError("Group name is required");
      return;
    }
    setCreating(true);
    setCreateError(null);
    setNotice(null);
    try {
      await api("/api/employee-groups", { method: "POST", body: JSON.stringify({ name }) });
      setNewName("");
      setNotice(`Group "${name}" created.`);
      await load();
    } catch (err) {
      setCreateError(fieldError(err, "Could not create the group"));
    } finally {
      setCreating(false);
    }
  }

  function startRename(group: EmployeeGroup) {
    setRenamingId(group.id);
    setRenameValue(group.name);
    setRenameError(null);
    setNotice(null);
  }

  async function handleRename(e: FormEvent) {
    e.preventDefault();
    if (!renamingId || renaming) return;
    const name = renameValue.trim();
    if (!name) {
      setRenameError("Group name is required");
      return;
    }
    setRenaming(true);
    setRenameError(null);
    try {
      await api(`/api/employee-groups/${renamingId}`, { method: "PATCH", body: JSON.stringify({ name }) });
      setRenamingId(null);
      setNotice(`Group renamed to "${name}".`);
      await load();
    } catch (err) {
      setRenameError(fieldError(err, "Could not rename the group"));
    } finally {
      setRenaming(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await api<{ ungroupedEmployees: number }>(`/api/employee-groups/${deleteTarget.id}`, { method: "DELETE" });
      setNotice(
        `Group "${deleteTarget.name}" deleted.` +
          (res.ungroupedEmployees > 0
            ? ` ${res.ungroupedEmployees} employee${res.ungroupedEmployees === 1 ? " is" : "s are"} now ${UNGROUPED_LABEL}.`
            : "")
      );
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Could not delete the group");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="employee-groups-tab">
      <p className="field-hint">
        Employee Groups organize the employee list — for example the Inputs sidebar. Assign an employee to a group from
        their Add or Edit Employee form. Groups don't affect permissions, Job group, Activity Groups, or any time records.
      </p>

      {isAdmin && (
        <form className="employee-groups-create" onSubmit={handleCreate} noValidate>
          <label>
            New group
            <input
              type="text"
              value={newName}
              maxLength={100}
              placeholder="Group name"
              onChange={(e) => {
                setNewName(e.target.value);
                setCreateError(null);
              }}
            />
          </label>
          <button type="submit" className="employees-add-button" disabled={creating}>
            {creating ? "Adding…" : "Add group"}
          </button>
          {createError && (
            <span className="field-error" role="alert">
              {createError}
            </span>
          )}
        </form>
      )}

      {notice && (
        <p className="success-text" role="status">
          {notice}
        </p>
      )}
      {loadError && <p className="error-text">{loadError}</p>}

      {!data && !loadError ? (
        <p>Loading...</p>
      ) : data ? (
        <table className="employees-table employee-groups-table">
          <thead>
            <tr>
              <th>Group</th>
              <th>Employees</th>
              {isAdmin && <th aria-label="Actions" />}
            </tr>
          </thead>
          <tbody>
            {data.groups.length === 0 && (
              <tr>
                <td colSpan={isAdmin ? 3 : 2} className="field-hint">
                  No employee groups yet{isAdmin ? " — add one above." : "."}
                </td>
              </tr>
            )}
            {data.groups.map((g) => (
              <tr key={g.id}>
                <td>
                  {renamingId === g.id ? (
                    <form className="employee-groups-rename" onSubmit={handleRename} noValidate>
                      <input
                        type="text"
                        aria-label={`New name for ${g.name}`}
                        value={renameValue}
                        maxLength={100}
                        autoFocus
                        onChange={(e) => {
                          setRenameValue(e.target.value);
                          setRenameError(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                      />
                      <button type="submit" disabled={renaming}>
                        {renaming ? "Saving…" : "Save"}
                      </button>
                      <button type="button" onClick={() => setRenamingId(null)} disabled={renaming}>
                        Cancel
                      </button>
                      {renameError && (
                        <span className="field-error" role="alert">
                          {renameError}
                        </span>
                      )}
                    </form>
                  ) : (
                    g.name
                  )}
                </td>
                <td>{countLabel(g.employeeCount, g.activeEmployeeCount)}</td>
                {isAdmin && (
                  <td className="employee-groups-actions">
                    {renamingId !== g.id && (
                      <>
                        <button type="button" onClick={() => startRename(g)}>
                          Rename
                        </button>
                        <button
                          type="button"
                          className="inputs-delete-btn"
                          onClick={() => {
                            setDeleteError(null);
                            setDeleteTarget(g);
                          }}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </td>
                )}
              </tr>
            ))}
            <tr className="employee-groups-ungrouped">
              <td>{UNGROUPED_LABEL}</td>
              <td>{countLabel(data.ungrouped.employeeCount, data.ungrouped.activeEmployeeCount)}</td>
              {isAdmin && <td />}
            </tr>
          </tbody>
        </table>
      ) : null}

      {deleteTarget && (
        <ConfirmDialog
          title={`Delete "${deleteTarget.name}"?`}
          message={
            deleteTarget.employeeCount > 0
              ? `The ${deleteTarget.employeeCount} employee${deleteTarget.employeeCount === 1 ? "" : "s"} in this group will become ${UNGROUPED_LABEL}. No employees are deleted, and nothing else about them changes.`
              : `This group has no employees. No employees are deleted.`
          }
          confirmLabel="Delete group"
          confirmingLabel="Deleting…"
          submitting={deleting}
          error={deleteError}
          onConfirm={handleDelete}
          onCancel={() => {
            if (!deleting) setDeleteTarget(null);
          }}
        />
      )}
    </div>
  );
}
