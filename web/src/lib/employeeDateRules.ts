// The vacation rules, mirrored from the server (employees.ts's
// endingDateErrors) so the Employment Timeline editor and the Employee form
// show the same message instantly; the server still checks every save.
// Empty strings mean "not entered" (form inputs).
export interface VacationRuleDates {
  startDate: string;
  workPermitExpiryDate: string;
  endDifferentDate: string;
  vacationStartDate: string;
  vacationEndDate: string;
}

export function vacationErrors(d: VacationRuleDates): Record<string, string> {
  const errors: Record<string, string> = {};
  const { vacationStartDate: vStart, vacationEndDate: vEnd } = d;
  if (!vStart && !vEnd) return errors;
  if (!vStart || !vEnd) {
    errors[vStart ? "vacationEndDate" : "vacationStartDate"] = "Enter both Start Vacation and End Vacation, or leave both empty";
    return errors;
  }
  if (vEnd < vStart) errors.vacationEndDate = "End Vacation can't be before Start Vacation";
  if (d.startDate && vStart < d.startDate) errors.vacationStartDate = "Start Vacation can't be before the Employment Start Date";
  const effectiveEnd = d.endDifferentDate || d.workPermitExpiryDate;
  if (effectiveEnd && vEnd > effectiveEnd && !errors.vacationEndDate) {
    errors.vacationEndDate = `End Vacation can't be after the ${d.endDifferentDate ? "End Different Date" : "Work Permit Expiry Date"} (${effectiveEnd})`;
  }
  return errors;
}
