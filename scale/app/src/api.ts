// Client for the local labourlink-scaled API (127.0.0.1 only). The display
// holds no business logic: it renders snapshots and forwards button presses.
import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "./types";

export const SERVICE_URL = (import.meta.env.VITE_SCALE_SERVICE_URL as string | undefined) ?? "http://127.0.0.1:47800";

export class ServiceError extends Error {
  status: number;
  errors: Record<string, string>;
  /** Machine-readable reason from the server or station (e.g. "tagOnOtherBin"). */
  code: string | null;
  /** The whole response body, for refusals that carry data. */
  data: Record<string, unknown>;
  constructor(status: number, message: string, errors: Record<string, string> = {}, code: string | null = null, data: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.errors = errors;
    this.code = code;
    this.data = data;
  }
}

export async function call<T>(path: string, init: { method?: string; body?: unknown; sessionToken?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.sessionToken) headers["X-Session-Token"] = init.sessionToken;
  let res: Response;
  try {
    res = await fetch(`${SERVICE_URL}${path}`, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ServiceError(0, "Scale service is not running");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errors = (data.errors ?? {}) as Record<string, string>;
    throw new ServiceError(res.status, Object.values(errors)[0] ?? data.error ?? `Error ${res.status}`, errors, data.code ?? null, data);
  }
  return data as T;
}

/** Live snapshot stream with automatic reconnect. null until the first one arrives. */
export function useSnapshot(): { snapshot: Snapshot | null; connected: boolean } {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const retry = useRef<number | undefined>(undefined);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    const open = () => {
      ws = new WebSocket(`${SERVICE_URL.replace(/^http/, "ws")}/api/ws`);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => {
        try {
          setSnapshot(JSON.parse(e.data as string) as Snapshot);
        } catch {
          /* ignore malformed frame */
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry.current = window.setTimeout(open, 1000);
      };
    };
    open();
    return () => {
      closed = true;
      window.clearTimeout(retry.current);
      ws?.close();
    };
  }, []);

  return { snapshot, connected };
}
