// Token scheme for a greenhouse_displays row (see 016_greenhouse_displays.sql)
// — deliberately the same crypto lib/resetToken.ts already uses (256 bits,
// URL-safe, sha256-hashed at rest), but kept as its own file rather than a
// shared import: resetToken.ts also exports a TTL constant specific to
// password reset, and a display token never expires on its own, only via
// explicit regenerate/deactivate. Reusing that file here would misdescribe
// both call sites.
import crypto from "crypto";

export function hashDisplayKey(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// The raw token is returned once, in the API response for create/regenerate
// only (see routes/greenhouseDisplays.ts) — never logged, never persisted.
// It's embedded directly in the TV's URL path (/greenhouse/display/<token>),
// not sent as a header, since the whole point is a mini PC that only needs
// to open one bookmarked URL with no login step.
export function generateDisplayKey(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, tokenHash: hashDisplayKey(token) };
}
