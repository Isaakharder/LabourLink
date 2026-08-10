import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import { SavedReportDetail } from "../../lib/reportTypes";

interface ActivityOption {
  id: string;
  name: string;
}

interface EditReportModalProps {
  reportId: string;
  onClose: () => void;
  onSaved: () => void;
}

// Edits only the report's identity (name, and for an Activity Report, its
// saved activity) — metric selection is edited from the opened report view
// instead (ReportViewPage), where the effect of a change is immediately
// visible against real data.
export function EditReportModal({ reportId, onClose, onSaved }: EditReportModalProps) {
  const [report, setReport] = useState<SavedReportDetail | null>(null);
  const [name, setName] = useState("");
  const [activityId, setActivityId] = useState<string | null>(null);
  const [activities, setActivities] = useState<ActivityOption[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ report: SavedReportDetail }>(`/api/reports/${reportId}`)
      .then((res) => {
        setReport(res.report);
        setName(res.report.name);
        setActivityId(res.report.activity?.id ?? null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load report"));
  }, [reportId]);

  useEffect(() => {
    if (report?.reportType !== "activity" || activities !== null) return;
    api<{ activities: ActivityOption[] }>("/api/activities?status=active")
      .then((res) => setActivities(res.activities))
      .catch(() => setActivities([]));
  }, [report, activities]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await api(`/api/reports/${reportId}`, {
        method: "PATCH",
        body: JSON.stringify({
          name,
          activityId: report?.reportType === "activity" ? activityId : undefined,
        }),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save report");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title="Edit Report"
      onClose={onClose}
      footer={
        !report ? undefined : (
          <div className="employee-form-actions">
            <button type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button
              type="button"
              className="employee-form-save"
              disabled={!name.trim() || (report.reportType === "activity" && !activityId) || saving}
              onClick={handleSave}
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        )
      }
    >
      {!report ? (
        <p>{error ?? "Loading..."}</p>
      ) : (
        <>
          <label>
            Name
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </label>

          {report.reportType === "activity" && (
            <label>
              Activity
              {activities === null ? (
                <p>Loading activities...</p>
              ) : (
                <select value={activityId ?? ""} onChange={(e) => setActivityId(e.target.value || null)}>
                  <option value="">Select an activity...</option>
                  {activities.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              )}
            </label>
          )}

          {error && <p className="error-text">{error}</p>}
        </>
      )}
    </Modal>
  );
}
