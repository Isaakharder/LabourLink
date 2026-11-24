// Kg/Hr for Job Reports. Not a calculation of its own: every figure comes
// from getScaleProductivity (lib/scaleProductivity.ts), the same function
// and allocation rules behind the Dashboard and the TV kg/hour slides:
// weighed, credited bins only; each bin reported on the local date it was
// weighed; nothing before SCALE_PRODUCTIVITY_START_DATE; shared bins
// allocated by matched minutes; bins waiting for review count for nobody.
//
// Rates are always ratios of sums: kilograms added up, matched seconds added
// up, then divided. Never an average of daily or employee rates.
import { pool } from "../db";
import { EmployeeScaleProductivity, getScaleProductivity, roundKgPerHour } from "./scaleProductivity";

export interface ReportKgFigures {
  netGrams: number;
  matchedSeconds: number;
  bins: number;
  // Rounded exactly like the TV (one decimal); null = no weighed bin yet.
  kgPerHour: number | null;
}

export interface ReportScaleProductivity {
  // First date kg/hour is reported for; null when the whole range is before
  // the start date.
  reportingFrom: string | null;
  byEmployeeDay: (ReportKgFigures & { employeeId: string; date: string })[];
  byEmployee: (ReportKgFigures & { employeeId: string; employeeName: string; openBins: number })[];
  byDate: (ReportKgFigures & { date: string })[];
  totals: ReportKgFigures;
}

function figures(e: EmployeeScaleProductivity): ReportKgFigures {
  return { netGrams: e.netGrams, matchedSeconds: e.matchedSeconds, bins: e.bins, kgPerHour: roundKgPerHour(e.kgPerHour) };
}

// Sums several employees' figures into one weighted figure.
export function combineKgFigures(list: ReportKgFigures[]): ReportKgFigures {
  const netGrams = list.reduce((s, f) => s + f.netGrams, 0);
  const matchedSeconds = list.reduce((s, f) => s + f.matchedSeconds, 0);
  const bins = list.reduce((s, f) => s + f.bins, 0);
  const kgPerHour = bins > 0 && matchedSeconds > 0 ? roundKgPerHour(netGrams / 1000 / (matchedSeconds / 3600)) : null;
  return { netGrams, matchedSeconds, bins, kgPerHour };
}

export async function getReportScaleProductivity(
  activityId: string,
  dateStart: string,
  dateEnd: string,
  employeeIds?: string[]
): Promise<ReportScaleProductivity> {
  const result = await getScaleProductivity(activityId, dateStart, dateEnd, { employeeIds: employeeIds ?? null });
  const counted = (e: EmployeeScaleProductivity) => e.bins > 0;

  const byEmployeeDay: ReportScaleProductivity["byEmployeeDay"] = [];
  const byDate: ReportScaleProductivity["byDate"] = [];
  for (const [date, employees] of [...result.byDateEmployee].sort(([a], [b]) => a.localeCompare(b))) {
    const list = [...employees.values()].filter(counted);
    if (!list.length) continue;
    for (const e of list) byEmployeeDay.push({ employeeId: e.employeeId, date, ...figures(e) });
    byDate.push({ date, ...combineKgFigures(list.map(figures)) });
  }

  const employees = [...result.byEmployee.values()];
  const ids = [...new Set([...employees.map((e) => e.employeeId), ...result.openBinsByEmployee.keys()])];
  const { rows: names } = ids.length
    ? await pool.query(`select id, first_name, last_name from employees where id = any($1::uuid[])`, [ids])
    : { rows: [] as { id: string; first_name: string; last_name: string }[] };
  const nameById = new Map(names.map((r) => [r.id as string, `${r.first_name} ${r.last_name}`]));

  const byEmployee = employees.map((e) => ({
    employeeId: e.employeeId,
    employeeName: nameById.get(e.employeeId) ?? "",
    openBins: result.openBinsByEmployee.get(e.employeeId) ?? 0,
    ...figures(e),
  }));

  return {
    reportingFrom: result.dateStart,
    byEmployeeDay,
    byEmployee,
    byDate,
    totals: combineKgFigures(employees.filter(counted).map(figures)),
  };
}
