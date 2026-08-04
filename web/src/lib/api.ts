import { DEVICE_ID_KEY, PERMANENT_DEVICE_ERROR_CODES } from "./device";
import { isNetworkError } from "./offlineQueue";

function resolveApiUrl(): string {
  const envUrl = import.meta.env.VITE_API_URL;
  if (envUrl) return envUrl;
  // No explicit API URL configured — reuse whatever host this page was
  // loaded from, on the API's port. Works for localhost dev and for a phone
  // hitting the dev machine's LAN IP alike, with no address hardcoded here.
  // Production deploys (frontend/backend on different domains) must set
  // VITE_API_URL explicitly, which takes priority over this.
  return `${window.location.protocol}//${window.location.hostname}:4000`;
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
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      ...(deviceId ? { "X-Device-Id": deviceId } : {}),
      ...options.headers,
    },
  });

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
