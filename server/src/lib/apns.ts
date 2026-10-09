import http2 from "http2";
import { createPrivateKey, KeyObject, sign } from "crypto";

// Direct APNs delivery for the iOS app (platform 'ios_apns' — see
// routes/mobilePush.ts and pushDelivery.ts). Token-based auth: one .p8 signing
// key from the Apple Developer account signs a short-lived ES256 JWT that
// authorizes every request; no per-app certificates to renew. Uses only
// Node's built-in http2/crypto.
//
// Required env (see server/.env.example): APNS_KEY_ID, APNS_TEAM_ID,
// APNS_PRIVATE_KEY (the full .p8 file contents). APNS_BUNDLE_ID defaults to
// the LabourLink bundle ID.

export type ApnsEnvironment = "production" | "sandbox";

export const APNS_HOSTS: Record<ApnsEnvironment, string> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};

export const DEFAULT_APNS_BUNDLE_ID = "com.linklogictechnologies.labourlink";

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  privateKey: KeyObject;
  bundleId: string;
}

// Railway env vars are single-line, so a pasted .p8 may arrive with literal
// "\n" sequences instead of newlines — both forms are accepted.
export function loadApnsConfig(env: NodeJS.ProcessEnv = process.env): ApnsConfig | null {
  const keyId = env.APNS_KEY_ID?.trim();
  const teamId = env.APNS_TEAM_ID?.trim();
  const rawKey = env.APNS_PRIVATE_KEY;
  if (!keyId || !teamId || !rawKey) return null;
  return {
    keyId,
    teamId,
    privateKey: createPrivateKey(rawKey.replace(/\\n/g, "\n")),
    bundleId: env.APNS_BUNDLE_ID?.trim() || DEFAULT_APNS_BUNDLE_ID,
  };
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

// ES256 JWT per Apple's "Establishing a token-based connection to APNs".
export function buildProviderToken(config: ApnsConfig, issuedAtSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: issuedAtSeconds }));
  const signingInput = `${header}.${claims}`;
  const signature = sign("sha256", Buffer.from(signingInput), { key: config.privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${base64url(signature)}`;
}

export type ApnsSendResult = { ok: true } | { ok: false; status: number; reason: string | null };

// Apple rejects tokens older than an hour and throttles refreshing more often
// than every 20 minutes — 40 minutes sits safely between the two.
const TOKEN_REFRESH_MS = 40 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

export class ApnsClient {
  private sessions = new Map<ApnsEnvironment, http2.ClientHttp2Session>();
  private token: { value: string; createdAt: number } | null = null;

  constructor(
    private readonly config: ApnsConfig,
    private readonly hosts: Record<ApnsEnvironment, string> = APNS_HOSTS,
    private readonly now: () => number = Date.now
  ) {}

  private providerToken(): string {
    const now = this.now();
    if (!this.token || now - this.token.createdAt >= TOKEN_REFRESH_MS) {
      this.token = { value: buildProviderToken(this.config, Math.floor(now / 1000)), createdAt: now };
    }
    return this.token.value;
  }

  private session(environment: ApnsEnvironment): http2.ClientHttp2Session {
    const existing = this.sessions.get(environment);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = http2.connect(this.hosts[environment]);
    const drop = () => {
      if (this.sessions.get(environment) === session) this.sessions.delete(environment);
    };
    session.on("error", drop);
    session.on("goaway", drop);
    session.on("close", drop);
    // Don't keep the process alive just for an idle APNs connection.
    session.unref();
    this.sessions.set(environment, session);
    return session;
  }

  send(environment: ApnsEnvironment, deviceToken: string, payload: object): Promise<ApnsSendResult> {
    return new Promise((resolve, reject) => {
      let req: http2.ClientHttp2Stream;
      try {
        req = this.session(environment).request({
          ":method": "POST",
          ":path": `/3/device/${deviceToken}`,
          authorization: `bearer ${this.providerToken()}`,
          "apns-topic": this.config.bundleId,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "content-type": "application/json",
        });
      } catch (err) {
        reject(err);
        return;
      }
      let status = 0;
      let body = "";
      req.setEncoding("utf8");
      req.setTimeout(REQUEST_TIMEOUT_MS, () => req.close(http2.constants.NGHTTP2_CANCEL));
      req.on("response", (headers) => {
        status = Number(headers[":status"]);
      });
      req.on("data", (chunk: string) => {
        body += chunk;
      });
      req.on("end", () => {
        if (status === 200) {
          resolve({ ok: true });
          return;
        }
        let reason: string | null = null;
        try {
          reason = (JSON.parse(body) as { reason?: string }).reason ?? null;
        } catch {
          // Non-JSON error body — status alone is all there is.
        }
        // A rejected provider token must be re-minted, not reused.
        if (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken") this.token = null;
        resolve({ ok: false, status, reason });
      });
      req.on("error", reject);
      req.end(JSON.stringify(payload));
    });
  }

  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}

// The token itself is permanently unusable for this app — disable the
// registration so future messages stop retrying it. (Other failures, e.g. a
// bad provider token or a 5xx, are server-side problems and must not
// disable a working device.)
export function isPermanentApnsTokenFailure(result: ApnsSendResult): boolean {
  if (result.ok) return false;
  return result.status === 410 || result.reason === "Unregistered" || result.reason === "DeviceTokenNotForTopic";
}

export interface ApnsDeliveryOutcome {
  result: ApnsSendResult;
  // The gateway that produced `result` — persisted on success so later sends
  // go straight to the right one.
  environment: ApnsEnvironment;
}

// Tries the registration's known gateway (production when unknown) and, on
// BadDeviceToken, the other one: a debug build's sandbox token is rejected by
// production with exactly that reason, and vice versa. If both reject it the
// token is treated as permanently invalid.
export async function sendWithEnvironmentFallback(
  client: Pick<ApnsClient, "send">,
  deviceToken: string,
  knownEnvironment: ApnsEnvironment | null,
  payload: object
): Promise<ApnsDeliveryOutcome> {
  const first: ApnsEnvironment = knownEnvironment ?? "production";
  const firstResult = await client.send(first, deviceToken, payload);
  if (firstResult.ok || firstResult.reason !== "BadDeviceToken") return { result: firstResult, environment: first };
  const second: ApnsEnvironment = first === "production" ? "sandbox" : "production";
  const secondResult = await client.send(second, deviceToken, payload);
  if (!secondResult.ok && secondResult.reason === "BadDeviceToken") {
    return { result: { ok: false, status: 410, reason: "BadDeviceToken" }, environment: second };
  }
  return { result: secondResult, environment: second };
}
