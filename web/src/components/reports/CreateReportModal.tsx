import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import {
  ACTIVITY_METRIC_LABELS,
  ACTIVITY_METRICS,
  ActivityMetric,
  PAYROLL_METRIC_LABELS,
  PAYROLL_METRICS,
  PayrollMetric,
  ReportType,
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

const DEFAULT_ACTIVITY_METRICS: ActivityMetric[] = [
  "employee",
  "date",
  "workTime",
  "breakTime",
  "totalHours",
  "quantityWorked",
  "averageSpeed",
];
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
export function CreateReportModal({ onClose, onSaved }: CreateReportModalProps) {
  const [step, setStep] = useState<Step>(1);
  const [reportType, setReportType] = useState<ReportType | null>(null);
  const [name, setName] = useState("");
  const [activities, setActivities] = useState<ActivityOption[] | null>(null);
  const [activityId, setActivityId] = useState<string | null>(null);
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
    setMetrics(type === "activity" ? DEFAULT_ACTIVITY_METRICS : DEFAULT_PAYROLL_METRICS);
    setStep(2);
  }

  function toggleMetric(key: string) {
    setMetrics((prev) => (prev.includes(key) ? prev.filter((m) => m !== key) : [...prev, key]));
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
          metrics,
        }),
      });
      onSaved(res.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save report");
    } finally {
      setSaving(false);
    }
  }

  const metricCatalog = reportType === "activity" ? ACTIVITY_METRICS : reportType === "payroll" ? PAYROLL_METRICS : [];
  const metricLabels: Record<string, string> = reportType === "activity" ? ACTIVITY_METRIC_LABELS : PAYROLL_METRIC_LABELS;
  const step3Valid = reportType === "payroll" || (reportType === "activity" && !!activityId);
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
            <button
              type="button"
              className="employee-form-save"
              disabled={!step3Valid || metrics.length === 0 || saving}
              onClick={handleSave}
            >
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

          <fieldset className="report-metrics-fieldset">
            <legend>Metrics / columns</legend>
            <div className="report-metrics-grid">
              {metricCatalog.map((m) => (
                <label key={m} className="report-metric-checkbox">
                  <input type="checkbox" checked={metrics.includes(m)} onChange={() => toggleMetric(m)} />
                  {metricLabels[m]}
                </label>
              ))}
            </div>
          </fieldset>

          {error && <p className="error-text">{error}</p>}
        </>
      )}
    </Modal>
  );
}
