// Only Canada and Mexico use a 10-digit local number that's ambiguous
// without a country-code hint — the employee's nationality selection
// (already being captured) is what decides which country code to apply for
// those two. This is intentionally simple rather than pulling in a full
// phone number library: "consistent normalized form where practical" per
// the spec, not full ITU validation. Every other nationality (including the
// 4 added for Employment Timeline: Jamaican, Guatemalan, Filipino, Thai)
// falls through to the same "+1" default a 10-digit non-Mexican number
// already got before those were added — unchanged behavior, just a wider
// accepted `nationality` type so this compiles against the full
// Nationality union.
export function normalizePhoneNumber(raw: string, nationality: string | null): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");

  if (trimmed.startsWith("+")) {
    return `+${digits}`;
  }
  if (digits.length === 10) {
    const countryCode = nationality === "Mexican" ? "52" : "1";
    return `+${countryCode}${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }
  // Doesn't match a recognized shape — store the digits as given rather than
  // guess a country code that could be wrong.
  return digits || trimmed;
}
