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
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const deviceId = localStorage.getItem(DEVICE_ID_KEY);
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(deviceId ? { "X-Device-Id": deviceId } : {}),
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error || "Request failed");
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}
