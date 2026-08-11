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

interface AddWorkStartModalProps {
  employeeId: string;
  employeeName: string;
  date: string;
  onClose: () => void;
  onCreated: () => void;
}

// Creates a brand-new work-start entry for a day with none yet — see
// server/src/routes/inputs.ts's POST /work-start for why this always
// requires an activity even though the button is framed as "just" a start
// time (every work-type time_entries row needs one). The section header's
// Add work start button is itself disabled/explained whenever a start
// already exists for the day, so this modal is only ever reachable on a
// genuinely blank day and doesn't re-check that itself — the server does,
// inside a per-employee lock, regardless.
export function AddWorkStartModal({ employeeId, employeeName, date, onClose, onCreated }: AddWorkStartModalProps) {
  const [selection, setSelection] = useState<ActivitySelectionValue>(EMPTY_ACTIVITY_SELECTION);
  const [activities, setActivities] = useState<EmployeeActivityOption[] | null>(null);
  const [startTime, setStartTime] = useState(() => toTimeInputValue(new Date().toISOString()));
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const selectedActivity = activities?.find((a) => a.id === selection.activityId);
  const reasonValid = reason.trim().length >= MIN_REASON_LENGTH;
  const canSubmit =
    Boolean(startTime) && reasonValid && isActivitySelectionComplete(selectedActivity, selection) && !submitting;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await api("/api/inputs/work-start", {
        method: "POST",
        body: JSON.stringify({
          employeeId,
          date,
          activityId: selection.activityId,
          answers: buildActivityAnswers(selectedActivity, selection),
          startTime: combineDateAndTimeToUtcIso(date, startTime),
          reason: reason.trim(),
        }),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add the work start");
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Add Work Start" onClose={submitting ? () => {} : onClose}>
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
            Work-start time *
            <input
              type="time"
              step={1}
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              disabled={submitting}
              required
            />
          </label>

          <label>
            Reason *
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Employee forgot to tap in on their phone"
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
            {submitting ? "Adding…" : "Add Work Start"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
