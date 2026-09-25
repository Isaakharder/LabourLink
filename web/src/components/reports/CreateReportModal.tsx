import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import {
  ACTIVITY_METRIC_LABELS,
  ActivityMetric,
  DAILY_METRIC_ELIGIBLE_ACTIVITY_METRICS,
  PAYROLL_METRIC_LABELS,
  PAYROLL_METRICS,
  PayrollMetric,
  ReportType,
  WEEKLY_TOTAL_ELIGIBLE_ACTIVITY_METRICS,
  WEEKLY_TOTAL_METRIC_LABELS,
} from "../../lib/reportTypes";

interface ActivityOption {
  id: string;
  name: string;
  isActive: boolean;
}

interface CreateReportModalProps {
  onClose: () => void;
  onSaved: (id: string) => void;
}

const DEFAULT_DAILY_METRIC: ActivityMetric = "workTime";
const DEFAULT_WEEKLY_TOTALS: ActivityMetric[] = ["activityHours"];
const DEFAULT_PAYROLL_METRICS: PayrollMetric[] = [
  "employee",
  "date",
  "workStart",
  "workEnd",
  "workTime",
  "breakTime",
  "paidTime",
  "totalHours",
];

type Step = 1 | 2 | 3;

// Three-step wizard: report type, name, type-specific configuration
// (activity for Activity Reports; both types also pick their initial
// columns here, editable again later from the opened report — see
// ReportViewPage).
//
// Activity and Payroll reports use two entirely different configuration
// models, each kept in its own state here: Payroll keeps the original flat
// `metrics` checkbox list (unchanged). Activity reports instead save a
// single "daily metric" (shown under each Monday-Sunday date column) plus
// one or more independently-chosen "weekly totals" (right-hand summary
// columns) — see reportPivot.ts's buildActivityPivotGrid and
// reportTypes.ts's DAILY_METRIC_ELIGIBLE_ACTIVITY_METRICS/
// WEEKLY_TOTAL_ELIGIBLE_ACTIVITY_METRICS. Both `dailyMetric`/`weeklyTotals`
// and `metrics` are declared unconditionally (not just for the active
// report type) since hooks/state can't be conditional, but only the
// relevant pair is ever read or sent.
export function CreateReportModal({ onClose, onSaved }: CreateReportModalProps) {
  const [step, setStep] = useState<Step>(1);
  const [reportType, setReportType] = useState<ReportType | null>(null);
  const [name, setName] = useState("");
  const [activities, setActivities] = useState<ActivityOption[] | null>(null);
  const [activityId, setActivityId] = useState<string | null>(null);
  const [dailyMetric, setDailyMetric] = useState<ActivityMetric>(DEFAULT_DAILY_METRIC);
  const [weeklyTotals, setWeeklyTotals] = useState<ActivityMetric[]>(DEFAULT_WEEKLY_TOTALS);
  const [metrics, setMetrics] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (reportType !== "activity" || activities !== null) return;
    api<{ activities: ActivityOption[] }>("/api/activities?status=active")
      .then((res) => setActivities(res.activities))
      .catch(() => setActivities([]));
  }, [reportType, activities]);

  function chooseType(type: ReportType) {
    setReportType(type);
    if (type === "activity") {
      setDailyMetric(DEFAULT_DAILY_METRIC);
      setWeeklyTotals(DEFAULT_WEEKLY_TOTALS);
    } else {
      setMetrics(DEFAULT_PAYROLL_METRICS);
    }
    setStep(2);
  }

  function toggleMetric(key: string) {
    setMetrics((prev) => (prev.includes(key) ? prev.filter((m) => m !== key) : [...prev, key]));
  }

  function toggleWeeklyTotal(key: ActivityMetric) {
    setWeeklyTotals((prev) => (prev.includes(key) ? prev.filter((m) => m !== key) : [...prev, key]));
  }

  async function handleSave() {
    if (!reportType) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api<{ id: string }>("/api/reports", {
        method: "POST",
        body: JSON.stringify({
          name,
          reportType,
          activityId: reportType === "activity" ? activityId : undefined,
          ...(reportType === "activity" ? { dailyMetric, weeklyTotals } : { metrics }),
        }),
      });
      onSaved(res.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save report");
    } finally {
      setSaving(false);
    }
  }

  const step3Valid =
    reportType === "payroll"
      ? metrics.length > 0
      : reportType === "activity"
        ? !!activityId && weeklyTotals.length > 0
        : false;
  const stepLabel = step === 1 ? "Step 1 of 3 — Choose report type" : step === 2 ? "Step 2 of 3 — Report name" : "Step 3 of 3 — Configuration";

  return (
    <Modal
      title="Create Report"
      onClose={onClose}
      wide
      footer={
        <div className="employee-form-actions">
          {step > 1 && (
            <button type="button" onClick={() => setStep((step - 1) as Step)} disabled={saving}>
              Back
            </button>
          )}
          {step === 1 && (
            <button type="button" onClick={onClose}>
              Cancel
            </button>
          )}
          {step === 2 && (
            <button type="button" className="employee-form-save" disabled={!name.trim()} onClick={() => setStep(3)}>
              Next
            </button>
          )}
          {step === 3 && (
            <button type="button" className="employee-form-save" disabled={!step3Valid || saving} onClick={handleSave}>
              {saving ? "Saving..." : "Save Report"}
            </button>
          )}
        </div>
      }
    >
      <p className="report-create-step-label">{stepLabel}</p>

      {step === 1 && (
        <div className="report-type-options">
          <button type="button" className="report-type-option" onClick={() => chooseType("activity")}>
            <strong>Activity Report</strong>
            <span>Speed, quantity, and time for one activity</span>
          </button>
          <button type="button" className="report-type-option" onClick={() => chooseType("payroll")}>
            <strong>Payroll Report</strong>
            <span>Paid time and hours across all employees</span>
          </button>
        </div>
      )}

      {step === 2 && (
        <label>
          Name
          <input
            type="text"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            placeholder={reportType === "activity" ? "e.g. Winding & Pruning — Weekly" : "e.g. Payroll — Biweekly"}
          />
        </label>
      )}

      {step === 3 && (
        <>
          {reportType === "activity" && (
            <>
              <label className="report-form-label">
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

              <label className="report-form-label">
                Daily metric (shown under each Mon–Sun date column)
                <select value={dailyMetric} onChange={(e) => setDailyMetric(e.target.value as ActivityMetric)}>
                  {DAILY_METRIC_ELIGIBLE_ACTIVITY_METRICS.map((m) => (
                    <option key={m} value={m}>
                      {ACTIVITY_METRIC_LABELS[m]}
                    </option>
                  ))}
                </select>
              </label>

              <fieldset className="report-metrics-fieldset">
                <legend>Weekly totals (right-hand summary columns)</legend>
                <div className="report-metrics-grid">
                  {WEEKLY_TOTAL_ELIGIBLE_ACTIVITY_METRICS.map((m) => (
                    <label key={m} className="report-metric-checkbox">
                      <input type="checkbox" checked={weeklyTotals.includes(m)} onChange={() => toggleWeeklyTotal(m)} />
                      {WEEKLY_TOTAL_METRIC_LABELS[m]}
                    </label>
                  ))}
                </div>
                {weeklyTotals.length === 0 && <p className="error-text">At least one weekly total must be selected</p>}
              </fieldset>
            </>
          )}

          {reportType === "payroll" && (
            <fieldset className="report-metrics-fieldset">
              <legend>Metrics / columns</legend>
              <div className="report-metrics-grid">
                {PAYROLL_METRICS.map((m) => (
                  <label key={m} className="report-metric-checkbox">
                    <input type="checkbox" checked={metrics.includes(m)} onChange={() => toggleMetric(m)} />
                    {PAYROLL_METRIC_LABELS[m]}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {error && <p className="error-text">{error}</p>}
        </>
      )}
    </Modal>
  );
}
