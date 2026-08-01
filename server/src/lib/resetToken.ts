import crypto from "crypto";

export const RESET_TOKEN_TTL_MINUTES = 30;

export function hashResetToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// 256 bits of entropy, URL-safe. The raw token is returned once (embedded in
// the emailed link) — only its sha256 digest is ever persisted, so a DB leak
// alone can't be used to complete a reset.
export function generateResetToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, tokenHash: hashResetToken(token) };
}
