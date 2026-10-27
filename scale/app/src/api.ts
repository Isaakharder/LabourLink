// Client for the local labourlink-scaled API (127.0.0.1 only). The display
// holds no business logic: it renders snapshots and forwards button presses.
import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "./types";

export const SERVICE_URL = (import.meta.env.VITE_SCALE_SERVICE_URL as string | undefined) ?? "http://127.0.0.1:47800";

export class ServiceError extends Error {
  status: number;
  errors: Record<string, string>;
  constructor(status: number, message: string, errors: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

export async function call<T>(path: string, init: { method?: string; body?: unknown; adminToken?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.adminToken) headers["X-Admin-Token"] = init.adminToken;
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
    throw new ServiceError(res.status, Object.values(errors)[0] ?? data.error ?? `Error ${res.status}`, errors);
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
