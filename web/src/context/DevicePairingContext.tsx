import { createContext, ReactNode, useCallback, useContext, useState } from "react";
import { clearDevicePaired, isDevicePaired, markDevicePaired } from "../lib/device";

interface DevicePairingContextValue {
  paired: boolean;
  markPaired: () => void;
  markUnpaired: () => void;
}

const DevicePairingContext = createContext<DevicePairingContextValue | undefined>(undefined);

export function DevicePairingProvider({ children }: { children: ReactNode }) {
  const [paired, setPaired] = useState(isDevicePaired);

  const markPaired = useCallback(() => {
    markDevicePaired();
    setPaired(true);
  }, []);

  // Called whenever a mobile API call comes back 401 — the device was
  // deactivated or unassigned server-side. Drops back to the pairing screen
  // immediately rather than leaving a dead session on screen.
  const markUnpaired = useCallback(() => {
    clearDevicePaired();
    setPaired(false);
  }, []);

  return (
    <DevicePairingContext.Provider value={{ paired, markPaired, markUnpaired }}>
      {children}
    </DevicePairingContext.Provider>
  );
}

export function useDevicePairing(): DevicePairingContextValue {
  const ctx = useContext(DevicePairingContext);
  if (!ctx) throw new Error("useDevicePairing must be used within DevicePairingProvider");
  return ctx;
}
