import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../context/AuthContext";
import { SavedReportSummary } from "../../lib/reportTypes";
import { CreateReportModal } from "../../components/reports/CreateReportModal";
import { EditReportModal } from "../../components/reports/EditReportModal";

const REPORT_TYPE_LABELS: Record<string, string> = {
  activity: "Activity Report",
  payroll: "Payroll Report",
};

function formatUpdatedAt(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function ReportsPage() {
  const navigate = useNavigate();
  const { employee } = useAuth();
  // Matches the server's MANAGE_ROLES (reports.ts) — Administrator only.
  // Manager can already reach this page (view-only, per RequireRole on the
  // route) but the create/edit/delete controls are hidden for them, same
  // pattern as any other role-restricted action in this app.
  const canManage = employee?.securityRole === "Administrator";
  const [reports, setReports] = useState<SavedReportSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ reports: SavedReportSummary[] }>("/api/reports")
      .then((res) => {
        setReports(res.reports);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load reports"));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleDelete(report: SavedReportSummary) {
    const proceed = window.confirm(`Delete "${report.name}"? This cannot be undone.`);
    if (!proceed) return;
    try {
      await api(`/api/reports/${report.id}`, { method: "DELETE" });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete report");
    }
  }

  return (
    <section className="employees-page">
      <div className="employees-toolbar">
        <h1>Reports</h1>
        <span className="employees-count">
          {reports ? `${reports.length} report${reports.length === 1 ? "" : "s"}` : ""}
        </span>
        {canManage && (
          <button type="button" className="employees-add-button" onClick={() => setCreating(true)}>
            Create Report
          </button>
        )}
      </div>

      {error && <p className="error-text">{error}</p>}

      {!reports ? (
        <p>Loading...</p>
      ) : reports.length === 0 ? (
        <p className="placeholder-page">No saved reports yet. Create one to get started.</p>
      ) : (
        <table className="employees-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Activity</th>
              <th>Last updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {reports.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td>{REPORT_TYPE_LABELS[r.reportType] ?? r.reportType}</td>
                <td>{r.activity?.name ?? "—"}</td>
                <td>{formatUpdatedAt(r.updatedAt)}</td>
                <td>
                  <div className="employee-row-actions">
                    <button type="button" onClick={() => navigate(`/reports/${r.id}`)}>
                      Open
                    </button>
                    {canManage && (
                      <>
                        <button type="button" onClick={() => setEditingId(r.id)}>
                          Edit
                        </button>
                        <button type="button" onClick={() => handleDelete(r)}>
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {creating && (
        <CreateReportModal
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            navigate(`/reports/${id}`);
          }}
        />
      )}

      {editingId && (
        <EditReportModal
          reportId={editingId}
          onClose={() => setEditingId(null)}
          onSaved={() => {
            setEditingId(null);
            load();
          }}
        />
      )}
    </section>
  );
}
