// Token scheme for an integration_tokens row (054_integration_tokens.sql)
// — same crypto shape as displayToken.ts (256-bit, URL-safe, sha256-hashed
// at rest) but kept as its own file: an integration token is sent as an
// Authorization header, never embedded in a URL the way a display token
// is, and — unlike displayToken.ts's generateDisplayKey — never has a
// recoverable plaintext copy persisted alongside its hash (see
// 054_integration_tokens.sql's own comment). This protects live employee
// speed data, not a TV's bookmarked link, so losing the printed token means
// issuing a new one, never reading it back out of the database.
import crypto from "crypto";

export function hashIntegrationToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function generateIntegrationToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, tokenHash: hashIntegrationToken(token) };
}
