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
  constructor(status: number, message: string, errors?: Record<string, string>, code?: string) {
    super(message);
    this.status = status;
    this.errors = errors;
    this.code = code;
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const deviceId = localStorage.getItem(DEVICE_ID_KEY);
  // FormData bodies must NOT get an explicit Content-Type — the browser sets
  // one itself (including the multipart boundary), which fetch can't do if
  // we've already set the header ourselves.
  const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
  // TEMPORARY — End Work ~1min delay investigation. Elapsed-time-only, no
  // secrets (no token/PIN/body content logged). Remove once the slow hop is
  // identified.
  const __t0 = performance.now();
  console.log(`[timing] fetch start: ${options.method ?? "GET"} ${path}`);
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      ...(deviceId ? { "X-Device-Id": deviceId } : {}),
      ...options.headers,
    },
  });
  console.log(`[timing] fetch response received: ${path} status=${res.status} elapsed=${Math.round(performance.now() - __t0)}ms`);

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    const firstFieldError = body.errors && Object.values(body.errors)[0];
    throw new ApiError(
      res.status,
      body.error || (typeof firstFieldError === "string" ? firstFieldError : "Request failed"),
      body.errors,
      typeof body.code === "string" ? body.code : undefined
    );
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}

// True only for a confirmed permanent device-auth rejection — the sole
// condition under which mobile pairing should ever be cleared (see
// DevicePairingContext.markUnpaired and PERMANENT_DEVICE_ERROR_CODES for the
// exact codes and why a 401 with no code, or an unrecognized code, does not
// count). Every mobile screen that talks to the API funnels its error
// handling through this one check instead of reimplementing it.
export function isPermanentDeviceAuthError(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 401 &&
    !!err.code &&
    (PERMANENT_DEVICE_ERROR_CODES as readonly string[]).includes(err.code)
  );
}

// True for "the server was not actually reached, or had a server-side
// problem" — a raw network failure/timeout, or any 5xx. Distinguishes
// "keep the last known good state and show Offline/Reconnecting" from "the
// server responded and rejected this request for a real, specific reason."
export function isServerUnreachableError(err: unknown): boolean {
  return isNetworkError(err) || (err instanceof ApiError && err.status >= 500);
}
