// One-time SQLite connection setup, shared by native Android and the
// browser/PWA — this is the ONE place platform branching happens for local
// storage; every caller above this (localEventStore.ts) uses the exact same
// SQLiteConnection/SQLiteDBConnection API regardless of platform. Same
// "dynamic import, memoized singleton" precedent as push.ts/nfc.ts, except
// SQLite must actually WORK on every platform (never a no-op) since it's the
// one and only local store, not an optional native enhancement.
import { Capacitor } from "@capacitor/core";

// Only resolved once per app session — every caller awaits the same promise,
// so a durable-write racing an in-progress init just queues behind it rather
// than kicking off a second, conflicting jeep-sqlite/database setup.
let connectionPromise: Promise<import("@capacitor-community/sqlite").SQLiteConnection> | null = null;

// jeep-sqlite (the web/PWA backend) persists to IndexedDB only on an
// explicit saveToStore()/close()/closeConnection() call, never automatically
// per-statement the way native SQLite fsyncs to disk — see docs/Web-Usage.md.
// Every durable write in localEventStore.ts must call saveToStore() itself
// on this platform; exported so that call site can branch on it without
// re-deriving "are we native" from Capacitor directly.
export function isNativeSqlite(): boolean {
  return Capacitor.isNativePlatform();
}

async function setUpWebStore(): Promise<void> {
  // applyPolyfills() is declared in this package's (stale) .d.ts but is no
  // longer actually exported by its real ESM build — confirmed by reading
  // node_modules/jeep-sqlite/dist/esm/loader.js directly, which exports
  // only defineCustomElements/setNonce. It's marked @deprecated upstream
  // (modern evergreen browsers don't need it), so this simply omits it
  // rather than importing a function that doesn't exist at runtime.
  const { defineCustomElements } = await import("jeep-sqlite/loader");
  defineCustomElements(window);

  if (!document.querySelector("jeep-sqlite")) {
    const el = document.createElement("jeep-sqlite");
    document.body.appendChild(el);
  }
  await customElements.whenDefined("jeep-sqlite");

  const { CapacitorSQLite, SQLiteConnection } = await import("@capacitor-community/sqlite");
  const sqlite = new SQLiteConnection(CapacitorSQLite);
  // Loads the wasm SQLite engine and opens/creates the backing IndexedDB
  // store — must happen before any createConnection() call on this platform.
  await sqlite.initWebStore();
  return;
}

export async function getSqliteConnection(): Promise<import("@capacitor-community/sqlite").SQLiteConnection> {
  if (connectionPromise) return connectionPromise;

  connectionPromise = (async () => {
    const { CapacitorSQLite, SQLiteConnection } = await import("@capacitor-community/sqlite");
    if (!isNativeSqlite()) {
      await setUpWebStore();
    }
    return new SQLiteConnection(CapacitorSQLite);
  })();

  return connectionPromise;
}
