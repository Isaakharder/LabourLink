import { DEVICE_ID_KEY } from "./device";

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
  constructor(status: number, message: string, errors?: Record<string, string>) {
    super(message);
    this.status = status;
    this.errors = errors;
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
      body.errors
    );
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}
