import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from "react";
import {
  CachedEmployeeSummary,
  DeactivationErrorCode,
  clearDevicePaired,
  getCachedEmployeeSummary,
  isDevicePaired,
  isDeactivationErrorCode,
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
//
// "deactivated" is reached only from a confirmed DEACTIVATION_ERROR_CODES
// rejection (device.ts) — an administrator genuinely deactivated this
// device, ended its assignment, or deactivated the employee. It shows a
// specific "contact an administrator" message and waits for an explicit
// "start pairing again" tap (see beginRepairing) rather than silently
// requesting a new pairing code the way plain "unpaired" does.
type PairingStatus = "checking" | "paired" | "unpaired" | "deactivated";

interface DevicePairingContextValue {
  status: PairingStatus;
  // Only meaningful while status === "deactivated" — which of the three
  // DEACTIVATION_ERROR_CODES caused it, so the UI can show the right
  // message (device.ts's DEACTIVATION_MESSAGES).
  deactivationCode: DeactivationErrorCode | null;
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
  // web/src/lib/api.ts's getPermanentDeviceAuthErrorCode) — never for a
  // network error, timeout, or 5xx. `code` is that rejection's specific
  // reason; when it's one of DEACTIVATION_ERROR_CODES, status becomes
  // "deactivated" instead of "unpaired" (see PairingStatus above).
  markUnpaired: (code?: string) => void;
  refreshCachedEmployee: (summary: CachedEmployeeSummary) => void;
  // The only way out of "deactivated" — an explicit tap on
  // DeviceDeactivatedScreen's "Start pairing again", never automatic. Clears
  // local pairing state exactly like markUnpaired, but deliberately keeps
  // the device identifier (see resetDeviceIdentity): it's still the same
  // physical phone, so the next pairing request re-uses this device's
  // existing row (and, once an admin approves it, its history) instead of
  // registering new hardware. This is also how a phone gets deliberately
  // handed to a different employee: an admin deactivates/unassigns it from
  // desktop Setup first (the only way to reach "deactivated" at all), then
  // whoever is holding the phone taps this to request a fresh pairing code
  // for the admin to approve.
  beginRepairing: () => void;
}

const DevicePairingContext = createContext<DevicePairingContextValue | undefined>(undefined);

export function DevicePairingProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<PairingStatus>("checking");
  const [deactivationCode, setDeactivationCode] = useState<DeactivationErrorCode | null>(null);
  const [cachedEmployee, setCachedEmployee] = useState<CachedEmployeeSummary | null>(null);
  const [serverReachable, setServerReachable] = useState(true);

  useEffect(() => {
    console.log("[device-identity] DevicePairingProvider mounted, starting recovery");
    let cancelled = false;
    recoverDeviceIdentityFromBackup().finally(() => {
      if (cancelled) return;
      setCachedEmployee(getCachedEmployeeSummary());
      const paired = isDevicePaired();
      console.log(`[device-identity] boot resolved status=${paired ? "paired" : "unpaired"}`);
      setStatus(paired ? "paired" : "unpaired");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const markPaired = useCallback(() => {
    markDevicePaired();
    setStatus("paired");
    setDeactivationCode(null);
    setServerReachable(true);
  }, []);

  const markUnpaired = useCallback((code?: string) => {
    clearDevicePaired();
    setCachedEmployee(null);
    if (isDeactivationErrorCode(code)) {
      setDeactivationCode(code);
      setStatus("deactivated");
    } else {
      setDeactivationCode(null);
      setStatus("unpaired");
    }
  }, []);

  const refreshCachedEmployee = useCallback((summary: CachedEmployeeSummary) => {
    setCachedEmployeeSummary(summary);
    setCachedEmployee(summary);
  }, []);

  const beginRepairing = useCallback(() => {
    resetDeviceIdentity();
    setDeactivationCode(null);
    setStatus("unpaired");
    setCachedEmployee(null);
    setServerReachable(true);
  }, []);

  return (
    <DevicePairingContext.Provider
      value={{
        status,
        deactivationCode,
        cachedEmployee,
        serverReachable,
        setServerReachable,
        markPaired,
        markUnpaired,
        refreshCachedEmployee,
        beginRepairing,
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
