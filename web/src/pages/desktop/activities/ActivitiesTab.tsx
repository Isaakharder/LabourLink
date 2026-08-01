import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../../lib/api";
import { Activity } from "../../../lib/activityTypes";
import { useAuth } from "../../../context/AuthContext";
import { ActivityFormModal } from "../../../components/activities/ActivityFormModal";
import { ActivityQuestionsModal } from "../../../components/activities/ActivityQuestionsModal";

type StatusFilter = "active" | "inactive" | "all";

function formatSpeed(activity: Activity): string {
  if (activity.normalSpeed == null) return "—";
  const speed = activity.normalSpeed;
  return activity.speedUnit ? `${speed} ${activity.speedUnit}` : String(speed);
}

export function ActivitiesTab() {
  const { employee: currentEmployee } = useAuth();
  const isAdmin = currentEmployee?.securityRole === "Administrator";

  const [activities, setActivities] = useState<Activity[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");

  const [modalActivity, setModalActivity] = useState<Activity | null | "new">(null);
  const [questionsActivity, setQuestionsActivity] = useState<Activity | null>(null);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    params.set("status", status);

    api<{ activities: Activity[] }>(`/api/activities?${params.toString()}`)
      .then((res) => {
        setActivities(res.activities);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "Could not load activities");
      });
  }, [search, status]);

  useEffect(() => {
    const t = window.setTimeout(load, search ? 300 : 0);
    return () => window.clearTimeout(t);
  }, [load, search]);

  async function handleToggleActive(activity: Activity) {
    if (activity.isActive) {
      const proceed = window.confirm(
        `Deactivate "${activity.name}"? It will no longer appear in the mobile activity picker. Historical time entries are unaffected.`
      );
      if (!proceed) return;
    }
    try {
      await api(`/api/activities/${activity.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !activity.isActive }),
      });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update activity");
    }
  }

  function renderActions(activity: Activity) {
    return (
      <div className="employee-row-actions">
        <button type="button" onClick={() => setQuestionsActivity(activity)}>
          Activity Questions
        </button>
        {isAdmin && (
          <>
            <button type="button" onClick={() => setModalActivity(activity)}>
              Edit
            </button>
            <button type="button" onClick={() => handleToggleActive(activity)}>
              {activity.isActive ? "Deactivate" : "Activate"}
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="employees-toolbar">
        <input
          type="search"
          placeholder="Search by activity name"
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
          {activities ? `${activities.length} activit${activities.length === 1 ? "y" : "ies"}` : ""}
        </span>

        {isAdmin && (
          <button type="button" className="employees-add-button" onClick={() => setModalActivity("new")}>
            Add Activity
          </button>
        )}
      </div>

      {error && <p className="error-text">{error}</p>}

      {!activities ? (
        <p>Loading...</p>
      ) : activities.length === 0 ? (
        <p className="placeholder-page">No activities match these filters.</p>
      ) : (
        <>
          <table className="employees-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Normal speed</th>
                <th>Minimum duration</th>
                <th>Status</th>
                <th>Groups</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {activities.map((a) => (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td>{formatSpeed(a)}</td>
                  <td>{a.minimumDurationMinutes} min</td>
                  <td>
                    <span className={`status-pill ${a.isActive ? "status-active" : "status-inactive"}`}>
                      {a.isActive ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td>{a.assignedGroupCount}</td>
                  <td>{renderActions(a)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="employee-cards">
            {activities.map((a) => (
              <div className="employee-card" key={a.id}>
                <div className="employee-card-header">
                  <div>
                    <div className="employee-card-name">{a.name}</div>
                    <span className={`status-pill ${a.isActive ? "status-active" : "status-inactive"}`}>
                      {a.isActive ? "Active" : "Inactive"}
                    </span>
                  </div>
                </div>
                <dl className="employee-card-fields">
                  <div>
                    <dt>Normal speed</dt>
                    <dd>{formatSpeed(a)}</dd>
                  </div>
                  <div>
                    <dt>Minimum duration</dt>
                    <dd>{a.minimumDurationMinutes} min</dd>
                  </div>
                  <div>
                    <dt>Groups</dt>
                    <dd>{a.assignedGroupCount}</dd>
                  </div>
                </dl>
                {renderActions(a)}
              </div>
            ))}
          </div>
        </>
      )}

      {modalActivity && (
        <ActivityFormModal
          activity={modalActivity === "new" ? null : modalActivity}
          onClose={() => setModalActivity(null)}
          onSaved={() => {
            setModalActivity(null);
            load();
          }}
        />
      )}

      {questionsActivity && (
        <ActivityQuestionsModal activity={questionsActivity} onClose={() => setQuestionsActivity(null)} />
      )}
    </>
  );
}
