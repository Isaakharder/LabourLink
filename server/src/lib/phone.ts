// Both supported countries (Canada, Mexico) use 10-digit local numbers, so a
// bare 10-digit input is ambiguous on its own — the employee's nationality
// selection (already being captured) is what decides which country code to
// apply. This is intentionally simple rather than pulling in a full phone
// number library: two countries, one shared local format, "consistent
// normalized form where practical" per the spec, not full ITU validation.
export function normalizePhoneNumber(
  raw: string,
  nationality: "Canadian" | "Mexican" | null
): string {
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
