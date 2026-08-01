import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PageHeader } from "../../components/layout/PageHeader";
import { DateNav } from "../../components/inputs/DateNav";
import { EmployeeListPanel } from "../../components/inputs/EmployeeListPanel";
import { ActivityLogsCard } from "../../components/inputs/ActivityLogsCard";
import { WorkdayDetailsCard } from "../../components/inputs/WorkdayDetailsCard";
import { CorrectionReasonModal } from "../../components/inputs/CorrectionReasonModal";
import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../context/AuthContext";
import { ActivityRunDto, DailyInputsResponse, InputsEmployee } from "../../lib/inputsTypes";
import {
  combineDateAndTimeToUtcIso,
  formatTimeInAppTimezone,
  todayInAppTimezone,
  toTimeInputValue,
} from "../../lib/timezone";

interface PendingCorrection {
  run: ActivityRunDto;
  newEndTimeIso: string;
}

export function InputsPage() {
  const { employee: currentEmployee } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const date = searchParams.get("date") ?? todayInAppTimezone();
  const selectedEmployeeId = searchParams.get("employee");

  const [employees, setEmployees] = useState<InputsEmployee[] | null>(null);
  const [employeesError, setEmployeesError] = useState<string | null>(null);
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [daily, setDaily] = useState<DailyInputsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [editingRunId, setEditingRunId] = useState<string | null>(null);
  const [editTimeValue, setEditTimeValue] = useState("");
  const [pendingCorrection, setPendingCorrection] = useState<PendingCorrection | null>(null);
  const [correctionSubmitting, setCorrectionSubmitting] = useState(false);
  const [correctionError, setCorrectionError] = useState<string | null>(null);

  function updateParams(next: { date?: string; employee?: string }) {
    const params = new URLSearchParams(searchParams);
    if (next.date !== undefined) params.set("date", next.date);
    if (next.employee !== undefined) params.set("employee", next.employee);
    setSearchParams(params, { replace: true });
  }

  const loadEmployees = useCallback(() => {
    const params = new URLSearchParams();
    if (employeeSearch.trim()) params.set("search", employeeSearch.trim());
    api<{ employees: InputsEmployee[] }>(`/api/inputs/employees?${params.toString()}`)
      .then((res) => {
        setEmployees(res.employees);
        setEmployeesError(null);
      })
      .catch((err) => {
        setEmployeesError(err instanceof ApiError ? err.message : "Could not load employees");
      });
  }, [employeeSearch]);

  useEffect(() => {
    const t = window.setTimeout(loadEmployees, employeeSearch ? 300 : 0);
    return () => window.clearTimeout(t);
  }, [loadEmployees, employeeSearch]);

  // Auto-select once an employee list is available and nothing is selected
  // yet (a fresh /inputs visit with no ?employee= param): prefer the
  // signed-in employee if they're in the active list, else the first
  // employee alphabetically. Guarded on selectedEmployeeId so this never
  // fires again — and never overrides an explicit pick — once ?employee= is
  // set, including by this same effect.
  useEffect(() => {
    if (selectedEmployeeId || !employees || employees.length === 0) return;
    const signedIn = currentEmployee ? employees.find((e) => e.id === currentEmployee.id) : undefined;
    updateParams({ employee: (signedIn ?? employees[0]).id, date });
  }, [employees, selectedEmployeeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadDaily = useCallback(() => {
    if (!selectedEmployeeId) return;
    api<DailyInputsResponse>(
      `/api/inputs/daily?employeeId=${encodeURIComponent(selectedEmployeeId)}&date=${encodeURIComponent(date)}`
    )
      .then((res) => {
        setDaily(res);
        setError(null);
        setSelectedRunId(null);
        setEditingRunId(null);
      })
      .catch((err) => {
        setDaily(null);
        setError(err instanceof ApiError ? err.message : "Could not load activity logs");
      });
  }, [selectedEmployeeId, date]);

  useEffect(() => {
    loadDaily();
  }, [loadDaily]);

  function handleSelectRun(id: string) {
    setSelectedRunId(id);
    if (editingRunId && editingRunId !== id) setEditingRunId(null);
  }

  function handleStartEdit(run: ActivityRunDto) {
    if (!run.canEdit || !run.endedAt) return;
    setEditingRunId(run.id);
    setEditTimeValue(toTimeInputValue(run.endedAt));
  }

  function handleCancelEdit() {
    setEditingRunId(null);
  }

  function handleSaveEdit() {
    if (!editingRunId || !daily || !editTimeValue) return;
    const run = daily.runs.find((r) => r.id === editingRunId);
    if (!run) return;
    const newEndTimeIso = combineDateAndTimeToUtcIso(date, editTimeValue);
    setEditingRunId(null);
    setCorrectionError(null);
    setPendingCorrection({ run, newEndTimeIso });
  }

  async function handleConfirmCorrection(reason: string) {
    if (!pendingCorrection) return;
    setCorrectionSubmitting(true);
    setCorrectionError(null);
    try {
      await api(`/api/inputs/activity-runs/${pendingCorrection.run.id}/end-time`, {
        method: "PATCH",
        body: JSON.stringify({ endTime: pendingCorrection.newEndTimeIso, reason }),
      });
      setPendingCorrection(null);
      loadDaily();
    } catch (err) {
      setCorrectionError(err instanceof ApiError ? err.message : "Could not save correction");
    } finally {
      setCorrectionSubmitting(false);
    }
  }

  function handleCancelCorrection() {
    if (correctionSubmitting) return;
    setPendingCorrection(null);
    setCorrectionError(null);
  }

  return (
    <div className="inputs-page">
      <PageHeader title="Inputs" description="Review and correct daily employee activity logs." />

      <DateNav date={date} onChange={(d) => updateParams({ date: d })} />

      <div className="inputs-layout">
        <EmployeeListPanel
          employees={employees}
          error={employeesError}
          selectedId={selectedEmployeeId}
          onSelect={(id) => updateParams({ employee: id })}
          search={employeeSearch}
          onSearchChange={setEmployeeSearch}
        />

        <div className="inputs-main">
          {error && <p className="error-text">{error}</p>}

          {!selectedEmployeeId ? (
            employeesError ? null : (
              <p className="placeholder-page">Select an employee to view their activity logs.</p>
            )
          ) : !daily ? (
            <p>Loading...</p>
          ) : (
            <>
              <ActivityLogsCard
                employee={daily.employee}
                date={daily.date}
                runs={daily.runs}
                totals={daily.totals}
                selectedRunId={selectedRunId}
                onSelectRun={handleSelectRun}
                editingRunId={editingRunId}
                editTimeValue={editTimeValue}
                onStartEdit={handleStartEdit}
                onEditTimeChange={setEditTimeValue}
                onSaveEdit={handleSaveEdit}
                onCancelEdit={handleCancelEdit}
              />
              <WorkdayDetailsCard workStartTime={daily.workStartTime} breaks={daily.breaks} />
            </>
          )}
        </div>
      </div>

      {pendingCorrection && (
        <CorrectionReasonModal
          activityName={pendingCorrection.run.activityName}
          oldEndTimeDisplay={
            pendingCorrection.run.endedAt ? formatTimeInAppTimezone(pendingCorrection.run.endedAt) : "—"
          }
          newEndTimeDisplay={formatTimeInAppTimezone(pendingCorrection.newEndTimeIso)}
          submitting={correctionSubmitting}
          error={correctionError}
          onConfirm={handleConfirmCorrection}
          onCancel={handleCancelCorrection}
        />
      )}
    </div>
  );
}
