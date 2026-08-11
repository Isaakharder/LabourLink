import { useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api";
import { CarrierOption, EmployeeActivityOption, GreenhouseRowOption } from "../../lib/inputsTypes";

// The activity/row/carrier/question selection used by both Add work start
// and Add activity (server/src/routes/inputs.ts's POST /work-start and
// /activities both validate through the identical
// server/src/lib/activitySelection.ts rules this fieldset's own picker
// data comes from) — one shared component so the two modals can't drift
// into two different pickers offering two different sets of activities.
export interface ActivitySelectionValue {
  activityId: string;
  greenhouseRowId: string;
  carrierId: string;
}

export const EMPTY_ACTIVITY_SELECTION: ActivitySelectionValue = {
  activityId: "",
  greenhouseRowId: "",
  carrierId: "",
};

interface AnswerInputPublic {
  questionId?: string;
  greenhouseRowId?: string;
  carrierId?: string;
}

// The exact { activityId, answers } shape POST /work-start and /activities
// both expect — built from the fieldset's own flat value plus the selected
// activity's own question list, so the caller never has to know the
// question ids itself.
export function buildActivityAnswers(
  activity: EmployeeActivityOption | undefined,
  value: ActivitySelectionValue
): AnswerInputPublic[] {
  if (!activity) return [];
  const answers: AnswerInputPublic[] = [];
  for (const q of activity.questions) {
    if (q.questionType === "greenhouse_row" && value.greenhouseRowId) {
      answers.push({ questionId: q.id, greenhouseRowId: value.greenhouseRowId });
    } else if (q.questionType === "carrier" && value.carrierId) {
      answers.push({ questionId: q.id, carrierId: value.carrierId });
    }
  }
  return answers;
}

// True once every required question on the selected activity has been
// answered — mirrors validateActivityAndAnswers's own required-question
// check, so the Save button disables before a doomed request round-trips.
export function isActivitySelectionComplete(
  activity: EmployeeActivityOption | undefined,
  value: ActivitySelectionValue
): boolean {
  if (!activity) return false;
  for (const q of activity.questions) {
    if (!q.isRequired) continue;
    if (q.questionType === "greenhouse_row" && !value.greenhouseRowId) return false;
    if (q.questionType === "carrier" && !value.carrierId) return false;
  }
  return true;
}

interface ActivitySelectionFieldsProps {
  employeeId: string;
  value: ActivitySelectionValue;
  onChange: (value: ActivitySelectionValue) => void;
  disabled?: boolean;
  // The caller (Add work start / Add activity) needs this same resolved
  // activity list itself, to compute buildActivityAnswers/
  // isActivitySelectionComplete at submit time — rather than fetching it a
  // second time in the parent, this fieldset (which already owns the
  // fetch, needed for the row/carrier question fields it renders) reports
  // its loaded list back up through this optional callback.
  onActivitiesLoaded?: (activities: EmployeeActivityOption[] | null) => void;
}

export function ActivitySelectionFields({
  employeeId,
  value,
  onChange,
  disabled,
  onActivitiesLoaded,
}: ActivitySelectionFieldsProps) {
  const [activities, setActivities] = useState<EmployeeActivityOption[] | null>(null);
  const [rows, setRows] = useState<GreenhouseRowOption[] | null>(null);
  const [carriers, setCarriers] = useState<CarrierOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    setActivities(null);
    setRows(null);
    setCarriers(null);
    setLoadError(null);
    onActivitiesLoaded?.(null);
    Promise.all([
      api<{ activities: EmployeeActivityOption[] }>(
        `/api/inputs/employee-activities?employeeId=${encodeURIComponent(employeeId)}`
      ),
      api<{ lands: GreenhouseRowOption[] }>("/api/inputs/greenhouse-rows"),
      api<{ carriers: CarrierOption[] }>("/api/inputs/carriers"),
    ])
      .then(([activitiesRes, rowsRes, carriersRes]) => {
        setActivities(activitiesRes.activities);
        setRows(rowsRes.lands);
        setCarriers(carriersRes.carriers);
        onActivitiesLoaded?.(activitiesRes.activities);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Could not load activity options"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId]);

  const selectedActivity = activities?.find((a) => a.id === value.activityId);
  const needsRow = selectedActivity?.questions.some((q) => q.questionType === "greenhouse_row") ?? false;
  const needsCarrier = selectedActivity?.questions.some((q) => q.questionType === "carrier") ?? false;
  const rowQuestion = selectedActivity?.questions.find((q) => q.questionType === "greenhouse_row");
  const carrierQuestion = selectedActivity?.questions.find((q) => q.questionType === "carrier");

  if (loadError) return <p className="error-text">{loadError}</p>;

  return (
    <>
      <label>
        Activity *
        <select
          value={value.activityId}
          disabled={disabled || !activities}
          required
          onChange={(e) => onChange({ activityId: e.target.value, greenhouseRowId: "", carrierId: "" })}
        >
          <option value="">{activities ? "Select an activity" : "Loading activities…"}</option>
          {activities?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        {activities && activities.length === 0 && (
          <span className="field-error">This employee has no active activity group assignment.</span>
        )}
      </label>

      {needsRow && (
        <label>
          {rowQuestion?.label || "Row"} {rowQuestion?.isRequired && "*"}
          <select
            value={value.greenhouseRowId}
            disabled={disabled || !rows}
            required={rowQuestion?.isRequired}
            onChange={(e) => onChange({ ...value, greenhouseRowId: e.target.value })}
          >
            <option value="">{rows ? "Select a row" : "Loading rows…"}</option>
            {rows?.map((land) =>
              land.phases.map((phase) => (
                <optgroup key={phase.id} label={`${land.name} — ${phase.name}`}>
                  {phase.rows.map((r) => (
                    <option key={r.id} value={r.id}>
                      Row {r.rowNumber}
                    </option>
                  ))}
                </optgroup>
              ))
            )}
          </select>
        </label>
      )}

      {needsCarrier && (
        <label>
          {carrierQuestion?.label || "Carrier"} {carrierQuestion?.isRequired && "*"}
          <select
            value={value.carrierId}
            disabled={disabled || !carriers}
            required={carrierQuestion?.isRequired}
            onChange={(e) => onChange({ ...value, carrierId: e.target.value })}
          >
            <option value="">{carriers ? "Select a carrier" : "Loading carriers…"}</option>
            {carriers?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  );
}
