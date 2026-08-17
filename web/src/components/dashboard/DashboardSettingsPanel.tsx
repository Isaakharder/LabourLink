import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import { DashboardSettingsActivity, GetDashboardSettingsResponse } from "../../lib/dashboardTypes";

const CARD_TYPE_LABEL: Record<string, string> = {
  row_stem: "Row/Stem Work",
  picking: "Picking",
};

interface DashboardSettingsPanelProps {
  onClose: () => void;
  onSaved: () => void;
}

export function DashboardSettingsPanel({ onClose, onSaved }: DashboardSettingsPanelProps) {
  const [activities, setActivities] = useState<DashboardSettingsActivity[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<GetDashboardSettingsResponse>("/api/dashboard/settings")
      .then((res) => {
        setActivities(res.activities);
        setSelectedIds(new Set(res.activities.filter((a) => a.selected).map((a) => a.activityId)));
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Could not load dashboard settings"));
  }, []);

  function toggle(activityId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(activityId)) next.delete(activityId);
      else next.add(activityId);
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      await api("/api/dashboard/settings", {
        method: "PUT",
        body: JSON.stringify({ activityIds: [...selectedIds] }),
      });
      onSaved();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Could not save dashboard settings");
      setSaving(false);
    }
  }

  return (
    <Modal
      title="Edit Dashboard"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="employees-add-button" onClick={handleSave} disabled={saving || !activities}>
            {saving ? "Saving..." : "Save"}
          </button>
        </>
      }
    >
      <p className="field-hint">
        Choose which activities appear on the Dashboard. Only employees currently doing a selected activity will show
        as a card. Card type (Row/Stem Work or Picking) is set automatically from each activity's own density
        configuration.
      </p>

      {loadError && <p className="error-text">{loadError}</p>}
      {saveError && <p className="error-text">{saveError}</p>}

      {!activities ? (
        <p>Loading...</p>
      ) : (
        <ul className="dashboard-settings-activity-list">
          {activities.map((a) => (
            <li key={a.activityId}>
              <label className={a.isActive ? "" : "dashboard-settings-activity-inactive"}>
                <input type="checkbox" checked={selectedIds.has(a.activityId)} onChange={() => toggle(a.activityId)} />
                <span className="dashboard-settings-activity-name">{a.activityName}</span>
                {!a.isActive && <span className="status-pill status-inactive">Inactive</span>}
                <span className="dashboard-settings-activity-cardtype">{CARD_TYPE_LABEL[a.cardType]}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
