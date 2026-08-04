import { uuid } from "./uuid";

// Kept in sync with server/src/middleware/device.ts's DeviceAuthErrorCode —
// the only codes a client is ever allowed to clear local pairing state for.
// A 401 with no code, or any code not in this list, must be treated as an
// ordinary (non-pairing-affecting) error — see api.ts's
// isPermanentDeviceAuthError, the sole place this list is consulted.
export const PERMANENT_DEVICE_ERROR_CODES = [
  "INVALID_DEVICE_IDENTIFIER",
  "DEVICE_NOT_FOUND",
  "DEVICE_INACTIVE",
  "DEVICE_UNASSIGNED",
  "EMPLOYEE_INACTIVE",
] as const;

export const DEVICE_ID_KEY = "labourlink_device_identifier";
const PAIRED_KEY = "labourlink_device_paired";
const EMPLOYEE_SUMMARY_KEY = "labourlink_paired_employee";

// Minimal, non-authoritative snapshot of who this device is paired to —
// used only to render a name and "last verified" time while offline at
// startup, before the server has had a chance to respond this session. The
// server (via requireDevice) remains the sole source of truth for whether
// the device is actually still valid; this cache is never treated as proof
// of anything.
export interface CachedEmployeeSummary {
  employeeId: string;
  firstName: string;
  lastName: string;
  photoUrl?: string | null;
  lastVerifiedAt: string; // ISO instant of the last successful /api/mobile/me
}

// ---------------------------------------------------------------------------
// IndexedDB backup — a second copy of the device identifier + paired flag +
// cached employee summary, mirrored on every write and consulted only if
// localStorage comes back empty at startup. This exists for one specific,
// documented reason: iOS Safari's Intelligent Tracking Prevention has, across
// several iOS versions, evicted script-writable storage (localStorage
// included) for web content that hasn't been opened directly in Safari
// itself within ~7 days — a real risk for exactly the "phone sits paired,
// untouched, for a while" scenario this whole audit is about. A home-screen
// PWA (display: standalone) gets its own storage partition that's generally
// more durable than a plain Safari tab's, but that behavior has shifted
// across iOS releases and isn't something to build a hard guarantee on. A
// second, independent storage API makes losing both simultaneously far less
// likely without adding any complexity to the normal (non-recovery) path,
// which still reads/writes localStorage synchronously as before.
// ---------------------------------------------------------------------------

const IDB_NAME = "labourlink-device";
const IDB_STORE = "kv";

function openIdb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) {
          req.result.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

// Fire-and-forget on every write — this is a backup copy, not the primary
// store, so nothing in the normal (online, localStorage-intact) path ever
// waits on it or fails because of it.
async function idbSet(key: string, value: string): Promise<void> {
  const db = await openIdb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } finally {
    db.close();
  }
}

async function idbGet(key: string): Promise<string | null> {
  const db = await openIdb();
  if (!db) return null;
  try {
    return await new Promise<string | null>((resolve) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(typeof req.result === "string" ? req.result : null);
      req.onerror = () => resolve(null);
    });
  } finally {
    db.close();
  }
}

async function idbDelete(key: string): Promise<void> {
  const db = await openIdb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } finally {
    db.close();
  }
}

function setMirrored(key: string, value: string): void {
  localStorage.setItem(key, value);
  void idbSet(key, value);
}

function removeMirrored(key: string): void {
  localStorage.removeItem(key);
  void idbDelete(key);
}

// Called once at app boot, before anything reads DEVICE_ID_KEY/PAIRED_KEY —
// if localStorage is missing what IndexedDB still has (the eviction case
// above), restore it into localStorage so every synchronous read elsewhere
// in the app (getOrCreateDeviceIdentifier, isDevicePaired, api.ts) just
// works without needing to know recovery ever happened. A no-op, resolving
// immediately, whenever localStorage already has the identifier — the
// common case on every launch after the first.
export async function recoverDeviceIdentityFromBackup(): Promise<void> {
  if (localStorage.getItem(DEVICE_ID_KEY)) return; // nothing to recover
  const [id, paired, employee] = await Promise.all([
    idbGet(DEVICE_ID_KEY),
    idbGet(PAIRED_KEY),
    idbGet(EMPLOYEE_SUMMARY_KEY),
  ]);
  if (!id) return; // no backup either — genuinely never paired on this origin
  localStorage.setItem(DEVICE_ID_KEY, id);
  if (paired) localStorage.setItem(PAIRED_KEY, paired);
  if (employee) localStorage.setItem(EMPLOYEE_SUMMARY_KEY, employee);
}

// Persistent, random, generated once per install — this identifier is the
// device's credential (see server/src/middleware/device.ts). It is never an
// employee's admin email/PIN, and it is created only when none exists —
// never regenerated on a later launch just because, say, a request failed.
export function getOrCreateDeviceIdentifier(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = uuid();
    setMirrored(DEVICE_ID_KEY, id);
  }
  return id;
}

export function isDevicePaired(): boolean {
  return localStorage.getItem(PAIRED_KEY) === "true";
}

export function markDevicePaired(): void {
  setMirrored(PAIRED_KEY, "true");
}

// Local flag only — does not delete the device_identifier itself, so a
// re-pair after deactivation reuses the same identifier rather than minting
// a brand new device row. Only ever called for a *confirmed permanent*
// device-auth rejection (see DevicePairingContext.markUnpaired) — never for
// a network error or a 5xx.
export function clearDevicePaired(): void {
  removeMirrored(PAIRED_KEY);
  removeMirrored(EMPLOYEE_SUMMARY_KEY);
}

export function getCachedEmployeeSummary(): CachedEmployeeSummary | null {
  const raw = localStorage.getItem(EMPLOYEE_SUMMARY_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CachedEmployeeSummary;
  } catch {
    return null;
  }
}

// Called after every successful /api/mobile/me response (and right after a
// fresh pairing approval) — always the full record, never a partial patch,
// so this can never drift from what the server actually last confirmed.
export function setCachedEmployeeSummary(summary: CachedEmployeeSummary): void {
  setMirrored(EMPLOYEE_SUMMARY_KEY, JSON.stringify(summary));
}

// The "Reset this device" action (Settings screen) — clears local pairing
// state and the cached employee summary, exactly like clearDevicePaired,
// but is kept as its own named function since the two happen for different
// reasons (a confirmed server-side permanent rejection vs. a deliberate
// manual action) and may need to diverge again later.
//
// Deliberately does NOT drop DEVICE_ID_KEY. The physical phone is still the
// same device — repurposing it to a new employee should go through pairing
// again with the *same* identifier, which the desktop Setup approval flow
// already treats as "re-pair this known device" (see devices.ts's approve
// route: it re-uses the existing devices row and just closes the old
// assignment/opens a new one) rather than minting a second device row for
// hardware that was never actually replaced. getOrCreateDeviceIdentifier
// only ever generates a new identifier when none exists locally — i.e. when
// browser storage was genuinely cleared, or on a first-ever launch — never
// as a side effect of this action.
export function resetDeviceIdentity(): void {
  removeMirrored(PAIRED_KEY);
  removeMirrored(EMPLOYEE_SUMMARY_KEY);
}
