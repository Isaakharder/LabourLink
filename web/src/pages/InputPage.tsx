import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { keepPreviousData } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import { workApi } from '../api/work';
import type { DashboardEmployee, Registration, DaySummary } from '../api/work';

// ── Utilities ─────────────────────────────────────────────────────────────────

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return '<1m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function liveSeconds(startedAt: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
}

function avatarBg(name: string): string {
  const palette = ['bg-violet-500', 'bg-blue-500', 'bg-teal-500', 'bg-amber-500', 'bg-rose-500', 'bg-indigo-500'];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) & 0xffffffff;
  return palette[Math.abs(h) % palette.length];
}

// ── Status config ─────────────────────────────────────────────────────────────

const STATUS: Record<DashboardEmployee['status'], { dot: string; label: string }> = {
  working:     { dot: 'bg-emerald-500', label: 'Working'     },
  on_break:    { dot: 'bg-amber-400',   label: 'On Break'    },
  on_lunch:    { dot: 'bg-orange-400',  label: 'Lunch'       },
  idle:        { dot: 'bg-blue-300',    label: 'Idle'        },
  clocked_out: { dot: 'bg-gray-300',    label: 'Clocked Out' },
};

const STATUS_ORDER: Record<DashboardEmployee['status'], number> = {
  working: 0, on_break: 1, on_lunch: 2, idle: 3, clocked_out: 4,
};

// ── Employee Panel ────────────────────────────────────────────────────────────

function EmployeePanel({
  employees,
  selectedId,
  onSelect,
}: {
  employees: DashboardEmployee[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  const sorted = [...employees].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      a.lastName.localeCompare(b.lastName),
  );

  const working = employees.filter(e => e.status === 'working').length;
  const onPause = employees.filter(e => e.status === 'on_break' || e.status === 'on_lunch').length;
  const out     = employees.filter(e => e.status === 'clocked_out').length;

  return (
    <aside className="w-72 flex-shrink-0 flex flex-col border-r border-gray-200 bg-white">
      {/* Panel header */}
      <div className="px-4 pt-4 pb-3 border-b border-gray-100 flex-shrink-0">
        <div className="flex items-center justify-between mb-2.5">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">
            <Users size={12} />
            Employees
          </div>
          <span className="text-xs text-gray-400">{employees.length} today</span>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="flex items-center gap-1 text-emerald-700">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            {working} working
          </span>
          {onPause > 0 && (
            <span className="flex items-center gap-1 text-amber-700">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
              {onPause} break
            </span>
          )}
          {out > 0 && (
            <span className="text-gray-400">{out} out</span>
          )}
        </div>
      </div>

      {/* Employee list */}
      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 ? (
          <div className="px-4 py-8 text-sm text-gray-400 text-center">
            No employees clocked in
          </div>
        ) : (
          sorted.map(emp => (
            <EmployeeRow
              key={emp.employeeId}
              emp={emp}
              selected={emp.employeeId === selectedId}
              onClick={() => onSelect(emp.employeeId)}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function EmployeeRow({
  emp,
  selected,
  onClick,
}: {
  emp: DashboardEmployee;
  selected: boolean;
  onClick: () => void;
}) {
  const cfg      = STATUS[emp.status];
  const initials = `${emp.firstName[0]}${emp.lastName[0]}`.toUpperCase();
  const bg       = avatarBg(emp.firstName + emp.lastName);

  const subtitle = emp.currentActivity
    ? `${emp.currentActivity.code}${emp.currentLocation ? ' · ' + emp.currentLocation.code : ''}`
    : cfg.label;

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-4 py-3 flex items-center gap-3 border-l-2 transition-colors ${
        selected
          ? 'bg-emerald-50 border-emerald-500'
          : 'border-transparent hover:bg-gray-50'
      }`}
    >
      <div className={`w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-semibold text-white ${bg}`}>
        {initials}
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 truncate leading-tight">
          {emp.firstName} {emp.lastName}
        </p>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${cfg.dot}`} />
          <span className="text-xs text-gray-500 truncate">{subtitle}</span>
        </div>
      </div>

      <span className="text-xs text-gray-400 flex-shrink-0 tabular-nums">
        {fmtDuration(emp.totalRegSeconds)}
      </span>
    </button>
  );
}

// ── Registration Timeline Card ────────────────────────────────────────────────

function RegistrationsCard({
  firstName,
  lastName,
  registrations,
  ticker,
}: {
  firstName: string;
  lastName: string;
  registrations: Registration[];
  ticker: number;
}) {
  void ticker; // triggers re-render for live elapsed
  const visible = registrations.filter(r => !r.isVoided);

  return (
    <div className="flex-1 min-h-0 bg-white rounded-xl border border-gray-200 flex flex-col overflow-hidden">
      {/* Card header */}
      <div className="px-5 py-3.5 border-b border-gray-100 flex items-center justify-between flex-shrink-0">
        <div>
          <p className="text-sm font-semibold text-gray-900">
            {firstName} {lastName}
          </p>
          <p className="text-xs text-gray-400 mt-0.5">Activity timeline</p>
        </div>
        <span className="text-xs text-gray-400">
          {visible.length} registration{visible.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <div className="py-10 text-sm text-gray-400 text-center">
            No activities registered yet
          </div>
        ) : (
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 bg-white border-b border-gray-100">
              <tr>
                <th className="pl-5 pr-2 py-2.5 text-left text-xs font-medium text-gray-400 w-6" />
                <th className="px-2 py-2.5 text-left text-xs font-medium text-gray-400">Activity</th>
                <th className="px-2 py-2.5 text-left text-xs font-medium text-gray-400">Location</th>
                <th className="px-2 py-2.5 text-left text-xs font-medium text-gray-400">Start</th>
                <th className="px-2 py-2.5 text-left text-xs font-medium text-gray-400">End</th>
                <th className="pl-2 pr-5 py-2.5 text-right text-xs font-medium text-gray-400">Duration</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(reg => {
                const isOpen = reg.endedAt === null;
                const dur    = isOpen ? liveSeconds(reg.startedAt) : (reg.durationSeconds ?? 0);

                return (
                  <tr
                    key={reg.id}
                    className={`border-b border-gray-50 last:border-0 ${isOpen ? 'bg-emerald-50/50' : ''}`}
                  >
                    <td className="pl-5 pr-2 py-3">
                      <span
                        className="w-2 h-2 rounded-full inline-block flex-shrink-0"
                        style={{
                          backgroundColor:
                            reg.activityColor ?? (reg.isBreak ? '#D97706' : '#9CA3AF'),
                        }}
                      />
                    </td>

                    <td className="px-2 py-3">
                      <span className="font-medium text-gray-800">{reg.activityName}</span>
                      {isOpen && (
                        <span className="ml-2 inline-flex items-center text-xs bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full font-medium">
                          live
                        </span>
                      )}
                    </td>

                    <td className="px-2 py-3">
                      <span className="font-mono text-xs text-gray-500">
                        {reg.locationCode ?? <span className="text-gray-300">—</span>}
                      </span>
                    </td>

                    <td className="px-2 py-3">
                      <span className="font-mono text-xs text-gray-600">
                        {fmtTime(reg.startedAt)}
                      </span>
                    </td>

                    <td className="px-2 py-3">
                      <span className="font-mono text-xs text-gray-400">
                        {reg.endedAt ? fmtTime(reg.endedAt) : '—'}
                      </span>
                    </td>

                    <td className="pl-2 pr-5 py-3 text-right">
                      <span
                        className={`text-xs font-semibold tabular-nums ${
                          isOpen
                            ? 'text-emerald-700'
                            : reg.isBreak
                            ? 'text-amber-600'
                            : 'text-gray-700'
                        }`}
                      >
                        {fmtDuration(dur)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── Day Summary Card ──────────────────────────────────────────────────────────

function SummaryCard({
  summary,
  registrations,
  ticker,
}: {
  summary: DaySummary;
  registrations: Registration[];
  ticker: number;
}) {
  void ticker;

  // Add live elapsed for any open registration so totals stay accurate
  const openWork  = registrations.find(r => !r.endedAt && !r.isBreak && !r.isVoided);
  const openBreak = registrations.find(r => !r.endedAt &&  r.isBreak && !r.isVoided);
  const liveReg   = openWork  ? liveSeconds(openWork.startedAt)  : 0;
  const liveBreak = openBreak ? liveSeconds(openBreak.startedAt) : 0;

  const totalWorked = summary.totalRegSeconds   + liveReg;
  const totalBreak  = summary.totalBreakSeconds + liveBreak;

  const breakSecs  = summary.breaks.reduce((s, b)  => s + (b.durationSeconds  ?? 0), 0);
  const lunchSecs  = summary.lunches.reduce((s, l) => s + (l.durationSeconds ?? 0), 0);

  return (
    <div className="flex-shrink-0 bg-white rounded-xl border border-gray-200 px-6 py-4">
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
        Day Summary
      </p>
      <div className="grid grid-cols-6 gap-6">
        <StatCell label="Work Start"   value={fmtTime(summary.clockedInAt)} />
        <StatCell
          label={`Breaks (${summary.breaks.length})`}
          value={breakSecs > 0 ? fmtDuration(breakSecs) : '—'}
        />
        <StatCell
          label={`Lunch (${summary.lunches.length})`}
          value={lunchSecs > 0 ? fmtDuration(lunchSecs) : '—'}
        />
        <StatCell
          label="Clock Out"
          value={summary.clockedOutAt ? fmtTime(summary.clockedOutAt) : '—'}
          muted={!summary.clockedOutAt}
        />
        <StatCell
          label="Total Worked"
          value={fmtDuration(totalWorked)}
          highlight
        />
        <StatCell
          label="Total Paid"
          value={summary.totalPaidSeconds !== null ? fmtDuration(summary.totalPaidSeconds) : '—'}
          muted={summary.totalPaidSeconds === null}
        />
      </div>
      {(openWork || openBreak) && (
        <p className="mt-2 text-xs text-emerald-600">
          Totals include ongoing registration
        </p>
      )}
    </div>
  );
}

function StatCell({
  label,
  value,
  highlight,
  muted,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  muted?: boolean;
}) {
  return (
    <div>
      <p className="text-xs text-gray-400 mb-1">{label}</p>
      <p
        className={`text-base font-semibold tabular-nums ${
          highlight ? 'text-emerald-700' : muted ? 'text-gray-300' : 'text-gray-800'
        }`}
      >
        {value}
      </p>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export function InputPage() {
  const [date, setDate]               = useState(todayIso);
  const [selectedId, setSelectedId]   = useState<number | null>(null);
  const [ticker, setTicker]           = useState(0);

  // Tick every second for live elapsed timers
  useEffect(() => {
    const id = setInterval(() => setTicker(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Dashboard — refreshes every 8 seconds
  const { data: dashboard, isLoading: dashLoading } = useQuery({
    queryKey: ['work-dashboard', date],
    queryFn:  () => workApi.inputDashboard(date),
    refetchInterval: 8000,
    placeholderData: keepPreviousData,
  });

  const employees = dashboard?.employees ?? [];

  // Auto-select first employee on initial load or date change
  useEffect(() => {
    if (selectedId === null && employees.length > 0) {
      setSelectedId(employees[0].employeeId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employees.length]);

  // Clear selection when date changes
  useEffect(() => {
    setSelectedId(null);
  }, [date]);

  // Day detail — refreshes every 8 seconds
  const { data: dayDetail, isLoading: dayLoading } = useQuery({
    queryKey: ['work-day', selectedId, date],
    queryFn:  () => workApi.employeeDay(selectedId!, date),
    enabled:  selectedId !== null,
    refetchInterval: 8000,
    placeholderData: keepPreviousData,
  });

  const selectedEmp = employees.find(e => e.employeeId === selectedId) ?? null;

  return (
    <div className="-m-8 h-full flex flex-col overflow-hidden">

      {/* ── Page header ─────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 bg-white border-b border-gray-200 px-8 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">Input</h1>
          <p className="text-xs text-gray-400 mt-0.5">Labour registrations · live</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5 text-xs text-gray-400">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-50" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
            auto-refresh
          </div>
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            className="text-sm border border-gray-200 rounded-md px-3 py-1.5 text-gray-700 bg-white focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500"
          />
        </div>
      </div>

      {/* ── Body ────────────────────────────────────────────────────────────── */}
      <div className="flex-1 flex overflow-hidden">

        {/* Left: employee list */}
        <EmployeePanel
          employees={employees}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />

        {/* Right: day view */}
        <div className="flex-1 flex flex-col gap-4 p-6 overflow-hidden">

          {/* No data states */}
          {!selectedEmp && (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-sm text-gray-400">
                {dashLoading
                  ? 'Loading…'
                  : employees.length === 0
                  ? 'No employees clocked in on this date'
                  : 'Select an employee to view their day'}
              </p>
            </div>
          )}

          {/* Day content */}
          {selectedEmp && (
            <>
              {dayLoading && !dayDetail ? (
                <div className="flex-1 flex items-center justify-center">
                  <p className="text-sm text-gray-400">Loading…</p>
                </div>
              ) : dayDetail ? (
                <>
                  <RegistrationsCard
                    firstName={selectedEmp.firstName}
                    lastName={selectedEmp.lastName}
                    registrations={dayDetail.registrations}
                    ticker={ticker}
                  />
                  <SummaryCard
                    summary={dayDetail.summary}
                    registrations={dayDetail.registrations}
                    ticker={ticker}
                  />
                </>
              ) : null}
            </>
          )}

        </div>
      </div>
    </div>
  );
}
