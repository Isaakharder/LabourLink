import { FormEvent, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import { formatDateLong, combineDateAndTimeToUtcIso, toTimeInputValue } from "../../lib/timezone";
import {
  ActivitySelectionFields,
  ActivitySelectionValue,
  buildActivityAnswers,
  EMPTY_ACTIVITY_SELECTION,
  isActivitySelectionComplete,
} from "./ActivitySelectionFields";
import { EmployeeActivityOption } from "../../lib/inputsTypes";

const MIN_REASON_LENGTH = 3;

interface AddActivityModalProps {
  employeeId: string;
  employeeName: string;
  date: string;
  onClose: () => void;
  onCreated: () => void;
}

// Creates a new activity log anywhere in the day — before, between, or
// after existing entries (server/src/routes/inputs.ts's POST /activities).
// Unlike Add work start, this is never blocked by "a work entry already
// exists" — only by a genuine time-range conflict, which the server always
// reports rather than silently resolving (see that route's own comment).
export function AddActivityModal({ employeeId, employeeName, date, onClose, onCreated }: AddActivityModalProps) {
  const [selection, setSelection] = useState<ActivitySelectionValue>(EMPTY_ACTIVITY_SELECTION);
  const [activities, setActivities] = useState<EmployeeActivityOption[] | null>(null);
  const [startTime, setStartTime] = useState(() => toTimeInputValue(new Date().toISOString()));
  const [inProgress, setInProgress] = useState(false);
  const [endTime, setEndTime] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const selectedActivity = activities?.find((a) => a.id === selection.activityId);
  const reasonValid = reason.trim().length >= MIN_REASON_LENGTH;
  const canSubmit =
    Boolean(startTime) &&
    (inProgress || Boolean(endTime)) &&
    reasonValid &&
    isActivitySelectionComplete(selectedActivity, selection) &&
    !submitting;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await api("/api/inputs/activities", {
        method: "POST",
        body: JSON.stringify({
          employeeId,
          date,
          activityId: selection.activityId,
          answers: buildActivityAnswers(selectedActivity, selection),
          startTime: combineDateAndTimeToUtcIso(date, startTime),
          endTime: inProgress ? null : combineDateAndTimeToUtcIso(date, endTime),
          reason: reason.trim(),
        }),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add the activity");
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Add Activity" onClose={submitting ? () => {} : onClose}>
      <form onSubmit={handleSubmit} className="employee-form" noValidate>
        <div className="employee-form-grid">
          <label>
            Employee
            <input type="text" value={employeeName} disabled readOnly />
          </label>
          <label>
            Date
            <input type="text" value={formatDateLong(date)} disabled readOnly />
          </label>

          <ActivitySelectionFields
            employeeId={employeeId}
            value={selection}
            onChange={setSelection}
            disabled={submitting}
            onActivitiesLoaded={setActivities}
          />

          <label>
            Start time *
            <input
              type="time"
              step={1}
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              disabled={submitting}
              required
            />
          </label>

          <label className="employee-form-checkbox">
            <input
              type="checkbox"
              checked={inProgress}
              onChange={(e) => setInProgress(e.target.checked)}
              disabled={submitting}
            />
            Still in progress (no end time yet)
          </label>

          {!inProgress && (
            <label>
              End time *
              <input
                type="time"
                step={1}
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                disabled={submitting}
                required
              />
            </label>
          )}

          <label>
            Reason *
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Employee forgot to switch activities on their phone"
              disabled={submitting}
              required
            />
          </label>
        </div>

        {error && <p className="error-text">{error}</p>}

        <div className="employee-form-actions">
          <button type="button" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="employees-add-button" disabled={!canSubmit}>
            {submitting ? "Adding…" : "Add Activity"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
