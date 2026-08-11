// True only when a *different* employee than the one already cached comes
// back from the server — never true for a device's first-ever pairing
// (cachedEmployeeId null, nothing to compare against) and never true when
// the same employee's data just refreshed. Deliberately a plain id
// comparison, not a deep-equality check on the whole record: a name change
// or updated photo for the *same* employee is not a reassignment.
export function detectReassignment(cachedEmployeeId: string | null, incomingEmployeeId: string): boolean {
  return cachedEmployeeId !== null && cachedEmployeeId !== incomingEmployeeId;
}
