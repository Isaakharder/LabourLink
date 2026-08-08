import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { useDevicePairing } from "./DevicePairingContext";
import { api, ApiError, isPermanentDeviceAuthError } from "../lib/api";
import { OutstandingMessage } from "../lib/messageTypes";

interface MessagesContextValue {
  // Every unacknowledged message for the paired employee, oldest first.
  pending: OutstandingMessage[];
  // The one message the blocking overlay currently shows — always
  // pending[0], exposed separately so PendingMessageOverlay doesn't need to
  // know the ordering rule itself.
  current: OutstandingMessage | null;
  acknowledging: boolean;
  error: string | null;
  acknowledge: () => void;
  refresh: () => void;
}

const MessagesContext = createContext<MessagesContextValue | undefined>(undefined);

// Owns the mandatory "does this employee have any outstanding message"
// check — mounted once in MobileLayout (alongside WorkSessionProvider) so
// it persists across mobile route changes and survives a tab switch.
// Deliberately its own small context rather than folded into
// WorkSessionContext: messaging is unrelated to time-tracking state, and
// this keeps that existing, sensitive context untouched.
//
// Event-driven refresh only (mount, `online`, tab/app foreground) — the
// same convention HomeScreen already uses for activities/rows/carriers, no
// new interval-polling framework.
export function MessagesProvider({ children }: { children: ReactNode }) {
  const { markUnpaired, setServerReachable } = useDevicePairing();
  const [pending, setPending] = useState<OutstandingMessage[]>([]);
  const [acknowledging, setAcknowledging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api<{ messages: OutstandingMessage[] }>("/api/mobile/messages/outstanding")
      .then((res) => {
        setPending(res.messages);
        setServerReachable(true);
      })
      .catch((err) => {
        if (isPermanentDeviceAuthError(err)) {
          markUnpaired();
          return;
        }
        // A network/server failure leaves `pending` exactly as it was —
        // never clears an overlay that's already correctly showing just
        // because a background refresh couldn't reach the server.
      });
  }, [markUnpaired, setServerReachable]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    function onOnline() {
      refresh();
    }
    function onVisibilityChange() {
      if (document.visibilityState === "visible") refresh();
    }
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refresh]);

  const current = pending[0] ?? null;

  const acknowledge = useCallback(() => {
    if (!current || acknowledging) return;
    setAcknowledging(true);
    setError(null);
    api<{ acknowledgedAt: string }>(`/api/mobile/messages/${current.recipientId}/acknowledge`, { method: "POST" })
      .then(() => {
        // Removes only the just-acknowledged message — if another is
        // already queued behind it, `current` (pending[0]) advances to it
        // automatically on the next render, showing one overlay at a time.
        setPending((prev) => prev.filter((m) => m.recipientId !== current.recipientId));
      })
      .catch((err) => {
        if (isPermanentDeviceAuthError(err)) {
          markUnpaired();
          return;
        }
        setError(err instanceof ApiError ? err.message : "Could not acknowledge this message. Please try again.");
      })
      .finally(() => setAcknowledging(false));
  }, [current, acknowledging, markUnpaired]);

  return (
    <MessagesContext.Provider value={{ pending, current, acknowledging, error, acknowledge, refresh }}>
      {children}
    </MessagesContext.Provider>
  );
}

export function useMessages(): MessagesContextValue {
  const ctx = useContext(MessagesContext);
  if (!ctx) throw new Error("useMessages must be used within MessagesProvider");
  return ctx;
}
