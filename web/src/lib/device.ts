import { uuid } from "./uuid";

export const DEVICE_ID_KEY = "labourlink_device_identifier";
const PAIRED_KEY = "labourlink_device_paired";

// Persistent, random, generated once per install — this identifier is the
// device's credential (see server/src/middleware/device.ts). It is never an
// employee's admin email/PIN.
export function getOrCreateDeviceIdentifier(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = uuid();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

export function isDevicePaired(): boolean {
  return localStorage.getItem(PAIRED_KEY) === "true";
}

export function markDevicePaired(): void {
  localStorage.setItem(PAIRED_KEY, "true");
}

// Local flag only — does not delete the device_identifier itself, so a
// re-pair after deactivation reuses the same identifier rather than minting
// a brand new device row.
export function clearDevicePaired(): void {
  localStorage.removeItem(PAIRED_KEY);
}
