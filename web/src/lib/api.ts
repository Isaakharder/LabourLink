import { DEVICE_ID_KEY, PERMANENT_DEVICE_ERROR_CODES } from "./device";
import { isNetworkError } from "./offlineQueue";

function resolveApiUrl(): string {
  const envUrl = import.meta.env.VITE_API_URL;
  if (envUrl) return envUrl;
  // Local/LAN dev only: the API runs on the same host, port 4000, no proxy
  // in front of it. Works for localhost and for a phone hitting the dev
  // machine's LAN IP alike, with no address hardcoded here.
  if (import.meta.env.DEV) {
    return `${window.location.protocol}//${window.location.hostname}:4000`;
  }
  // Production browser/PWA build: deliberately no VITE_API_URL, so API calls
  // stay relative and same-origin with the page. web/serve-static.js proxies
  // /api/* to the real API service server-side. This keeps the session
  // cookie same-site — see the cookie comment in server/src/routes/auth.ts —
  // so Safari's cross-site cookie blocking (ITP) can't silently drop it, the
  // way it does when the browser talks to the API's own cross-site domain.
  // (The Android build is unaffected: it sets VITE_API_URL explicitly via
  // .env.android and returns above.)
  return "";
}

const API_URL = resolveApiUrl();
// Exposed for on-device diagnostics (Settings > Sync details) — reading
// which API host a build actually talks to is otherwise invisible on a
// physical phone. Not used for any request logic outside this file.
export { API_URL };

// A weak-signal connection (still associated with the AP, but losing most
// packets) can leave a bare fetch() hanging far longer than a clean refusal
// would — long enough that a cold-start reconnect loop never even gets a
// chance to start (see DEFAULT_TIMEOUT_MS below and the mobile offline
// investigation this fixes). AbortController bounds every call so a hung
// request always surfaces as a prompt, ordinary network failure instead of
// an indefinite wait. 15s comfortably exceeds legitimate slow-but-working
// calls (proven elsewhere in this codebase against a real 5-second
// simulated delay) while still being "prompt" for a genuinely dead
// connection.
const DEFAULT_TIMEOUT_MS = 15000;

// Deliberately a TypeError subclass: isNetworkError()/isServerUnreachableError()
// (offlineQueue.ts) already treat `err instanceof TypeError` as "network
// problem, safe to retry, never data loss" — subclassing means an
// intentional timeout is automatically classified exactly the same way
// (offline/reconnecting, pending events untouched) with no changes needed
// to that shared classification logic. `timeout` distinguishes it from an
// ordinary fetch() TypeError (e.g. a malformed URL) for callers/diagnostics
// that care specifically about "this was a timeout," without changing how
// it's treated by anything that doesn't.
export class ApiTimeoutError extends TypeError {
  timeout = true;
  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = "ApiTimeoutError";
  }
}

export class ApiError extends Error {
  status: number;
  // Field-level validation errors, e.g. { email: "..." } — present when the
  // server responded with { errors: {...} } instead of a single { error }.
  errors?: Record<string, string>;
  // Stable machine-readable reason, e.g. "DEVICE_INACTIVE" (see
  // server/src/middleware/device.ts). Only ever set for responses that
  // include one — a plain 401/500 with no code is deliberately left
  // undefined, not guessed at, so callers can't mistake an unrelated error
  // for a specific one.
  code?: string;
  // The full parsed JSON body, for the handful of callers (e.g. the NFC tag
  // registration 409s — see nfcTags.ts's tagConflict/targetConflict) that
  // need structured data beyond error/errors/code. Most callers never touch
  // this and should keep reading the fields above instead.
  body?: unknown;
  constructor(status: number, message: string, errors?: Record<string, string>, code?: string, body?: unknown) {
    super(message);
    this.status = status;
    this.errors = errors;
    this.code = code;
    this.body = body;
  }
}

export interface ApiOptions extends RequestInit {
  // Overrides DEFAULT_TIMEOUT_MS for one call — no caller in this codebase
  // needs this today, but a genuinely long-running endpoint added later can
  // opt into a longer bound without changing the default for everything
  // else.
  timeoutMs?: number;
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const deviceId = localStorage.getItem(DEVICE_ID_KEY);
  // FormData bodies must NOT get an explicit Content-Type — the browser sets
  // one itself (including the multipart boundary), which fetch can't do if
  // we've already set the header ourselves.
  const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: callerSignal, ...fetchOptions } = options;

  const controller = new AbortController();
  // A caller-supplied signal (none exist today, but api() shouldn't silently
  // drop one added later) aborts the same request the timeout would.
  callerSignal?.addEventListener("abort", () => controller.abort());
  const timer = setTimeout(() => controller.abort(new ApiTimeoutError(timeoutMs)), timeoutMs);

  // TEMPORARY — End Work ~1min delay investigation. Elapsed-time-only, no
  // secrets (no token/PIN/body content logged). Remove once the slow hop is
  // identified.
  const __t0 = performance.now();
  console.log(`[timing] fetch start: ${options.method ?? "GET"} ${path}`);
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...fetchOptions,
      credentials: "include",
      signal: controller.signal,
      headers: {
        ...(isFormData ? {} : { "Content-Type": "application/json" }),
        ...(deviceId ? { "X-Device-Id": deviceId } : {}),
        ...options.headers,
      },
    });
  } catch (err) {
    // Not every environment honors AbortController's reason argument (older
    // WebViews may still throw a bare DOMException "AbortError") — normalize
    // either shape to the same ApiTimeoutError so callers/classification
    // never need to special-case it.
    if (controller.signal.aborted) throw new ApiTimeoutError(timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  console.log(`[timing] fetch response received: ${path} status=${res.status} elapsed=${Math.round(performance.now() - __t0)}ms`);

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    const firstFieldError = body.errors && Object.values(body.errors)[0];
    throw new ApiError(
      res.status,
      body.error || (typeof firstFieldError === "string" ? firstFieldError : "Request failed"),
      body.errors,
      typeof body.code === "string" ? body.code : undefined,
      body
    );
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}

// The specific permanent-rejection code for a confirmed permanent device-auth
// error, or null for anything else — the sole condition under which mobile
// pairing should ever be cleared (see DevicePairingContext.markUnpaired and
// PERMANENT_DEVICE_ERROR_CODES for the exact codes and why a 401 with no
// code, or an unrecognized code, does not count). Every mobile screen that
// talks to the API funnels its error handling through this one check instead
// of reimplementing it. Returns the code (rather than just a boolean) so
// markUnpaired can tell "genuinely deactivated/unassigned by an admin" apart
// from "never a recognized paired device" and show the right message.
export function getPermanentDeviceAuthErrorCode(err: unknown): string | null {
  if (
    err instanceof ApiError &&
    err.status === 401 &&
    !!err.code &&
    (PERMANENT_DEVICE_ERROR_CODES as readonly string[]).includes(err.code)
  ) {
    return err.code;
  }
  return null;
}

export function isPermanentDeviceAuthError(err: unknown): boolean {
  return getPermanentDeviceAuthErrorCode(err) !== null;
}

// True for "the server was not actually reached, or had a server-side
// problem" — a raw network failure/timeout, or any 5xx. Distinguishes
// "keep the last known good state and show Offline/Reconnecting" from "the
// server responded and rejected this request for a real, specific reason."
export function isServerUnreachableError(err: unknown): boolean {
  return isNetworkError(err) || (err instanceof ApiError && err.status >= 500);
}
