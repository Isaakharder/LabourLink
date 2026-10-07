import crypto from "crypto";

// App-store reviewer access (see migrations/058_reviewer_pairing.sql). The
// reviewer pairing endpoint only ever runs on a separate demo deployment —
// gated by BOTH this env flag (set only on the demo API service) and the
// demo_instance marker row in that service's own database.
export function isDemoInstanceEnabled(): boolean {
  return process.env.LABOURLINK_DEMO_INSTANCE === "true";
}

interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;
}

export async function hasDemoInstanceMarker(db: Queryable): Promise<boolean> {
  const { rows } = await db.query(`select 1 from demo_instance where id = true`);
  return rows.length > 0;
}

// The production API's only part in reviewer access: telling a freshly
// installed app where the demo API lives, so that URL can change without an
// app rebuild. Never a credential — just a public https origin. Anything that
// isn't a plain https origin is treated as unset rather than handed to phones.
// DEMO_API_URL_ALLOW_HTTP=true permits http for local emulator testing only
// (paired with the QA emulator build) — never set it on a deployed service.
export function configuredDemoApiUrl(): string | null {
  const raw = process.env.DEMO_API_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const protocolOk = url.protocol === "https:" || (process.env.DEMO_API_URL_ALLOW_HTTP === "true" && url.protocol === "http:");
    if (!protocolOk || url.username || url.password) return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

// Unambiguous alphabet (no 0/O, 1/I/L) — reviewers type these by hand.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_GROUPS = 3;
const CODE_GROUP_LENGTH = 4;

// "DEMO-XXXX-XXXX-XXXX": 12 random characters from a 31-symbol alphabet
// (~59 bits) — far beyond online guessing, on top of the endpoint's
// failed-attempt throttle.
export function generateReviewerCode(): { code: string; codeHash: string; codeHint: string } {
  const groups: string[] = [];
  for (let g = 0; g < CODE_GROUPS; g++) {
    let group = "";
    for (let i = 0; i < CODE_GROUP_LENGTH; i++) {
      group += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
    groups.push(group);
  }
  const code = `DEMO-${groups.join("-")}`;
  const normalized = normalizeReviewerCode(code);
  return { code, codeHash: hashReviewerCode(normalized), codeHint: normalized.slice(-4) };
}

// Case-, space- and dash-insensitive, so "demo xxxx xxxx xxxx" typed on a
// phone keyboard matches.
export function normalizeReviewerCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function hashReviewerCode(normalized: string): string {
  return crypto.createHash("sha256").update(normalized).digest("hex");
}
