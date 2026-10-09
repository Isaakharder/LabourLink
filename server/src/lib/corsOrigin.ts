// Parses the CORS_ORIGIN env var into the array express's `cors` middleware
// checks an incoming request's Origin header against (see server/src/index.ts).
// Extracted out of index.ts so it's importable by a test without importing
// index.ts itself (which calls app.listen() unconditionally at module load).
//
// Trims surrounding whitespace and drops empty entries — a stray trailing
// comma ("a,b,"), a double comma from a copy-paste edit ("a,,b"), or
// whitespace-only padding around a comma ("a, b") must never survive into
// the array `cors` matches against. An empty string is not a meaningful
// origin (a browser's Origin header is never itself empty), so silently
// keeping one wouldn't just be untidy — .split(",") always yields empty
// strings around any of these, and cors's own matching is a plain
// `array.includes(requestOrigin)`, which would only mismatch a genuine
// empty Origin header anyway (browsers don't send one) rather than acting
// as a safety net, so this filtering is what actually keeps the allow-list
// exactly the entries someone meant to list.
export function parseCorsOrigins(raw: string | undefined): string[] {
  const value = raw || "http://localhost:5173";
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
