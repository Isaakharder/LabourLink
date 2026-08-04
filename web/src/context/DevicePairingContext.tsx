import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from "react";
import {
  CachedEmployeeSummary,
  clearDevicePaired,
  getCachedEmployeeSummary,
  isDevicePaired,
  markDevicePaired,
  recoverDeviceIdentityFromBackup,
  resetDeviceIdentity,
  setCachedEmployeeSummary,
} from "../lib/device";

// "checking" is the brief (localStorage is already synchronous in the
// common case; only the rare IndexedDB-recovery path adds real async time)
// window at boot while recoverDeviceIdentityFromBackup runs, before it's
// safe to decide Pairing vs Home — deciding too early risks flashing the
// pairing screen (and firing its own pairing/request call) for a device
// that's actually still validly paired, just recovering from a wiped
// localStorage.
type PairingStatus = "checking" | "paired" | "unpaired";

interface DevicePairingContextValue {
  status: PairingStatus;
  cachedEmployee: CachedEmployeeSummary | null;
  // Whether the last mobile API call actually reached the server — distinct
  // from the browser's own navigator.onLine (which only knows about the
  // network interface, not whether labourlink's API specifically is
  // reachable; a dead Railway deploy with perfectly good Wi-Fi still needs
  // this to go false). Never affects `status` on its own.
  serverReachable: boolean;
  setServerReachable: (reachable: boolean) => void;
  markPaired: () => void;
  // Called ONLY for a confirmed permanent device-auth rejection (see
  // web/src/lib/api.ts's PERMANENT_DEVICE_ERROR_CODES) — never for a
  // network error, timeout, or 5xx.
  markUnpaired: () => void;
  refreshCachedEmployee: (summary: CachedEmployeeSummary) => void;
  // "Reset this device" (Settings screen) — a deliberate, confirmed local
  // action distinct from markUnpaired only in *why* it happens, not what it
  // clears: local pairing state and the cached employee summary, same as
  // markUnpaired. The device identifier itself is deliberately kept (see
  // resetDeviceIdentity) — it's still the same physical phone, so the next
  // pairing re-uses this device's existing row instead of minting a new one.
  resetDevice: () => void;
}

const DevicePairingContext = createContext<DevicePairingContextValue | undefined>(undefined);

export function DevicePairingProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<PairingStatus>("checking");
  const [cachedEmployee, setCachedEmployee] = useState<CachedEmployeeSummary | null>(null);
  const [serverReachable, setServerReachable] = useState(true);

  useEffect(() => {
    let cancelled = false;
    recoverDeviceIdentityFromBackup().finally(() => {
      if (cancelled) return;
      setCachedEmployee(getCachedEmployeeSummary());
      setStatus(isDevicePaired() ? "paired" : "unpaired");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const markPaired = useCallback(() => {
    markDevicePaired();
    setStatus("paired");
    setServerReachable(true);
  }, []);

  const markUnpaired = useCallback(() => {
    clearDevicePaired();
    setStatus("unpaired");
    setCachedEmployee(null);
  }, []);

  const refreshCachedEmployee = useCallback((summary: CachedEmployeeSummary) => {
    setCachedEmployeeSummary(summary);
    setCachedEmployee(summary);
  }, []);

  const resetDevice = useCallback(() => {
    resetDeviceIdentity();
    setStatus("unpaired");
    setCachedEmployee(null);
    setServerReachable(true);
  }, []);

  return (
    <DevicePairingContext.Provider
      value={{
        status,
        cachedEmployee,
        serverReachable,
        setServerReachable,
        markPaired,
        markUnpaired,
        refreshCachedEmployee,
        resetDevice,
      }}
    >
      {children}
    </DevicePairingContext.Provider>
  );
}

export function useDevicePairing(): DevicePairingContextValue {
  const ctx = useContext(DevicePairingContext);
  if (!ctx) throw new Error("useDevicePairing must be used within DevicePairingProvider");
  return ctx;
}
