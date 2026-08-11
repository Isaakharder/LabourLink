import { beforeEach, describe, expect, it } from "vitest";
import { createFakeStorage } from "./testUtils/fakeStorage";
import { resolveLanguage, t, translateServerMessage, TranslationKey } from "./i18n";

describe("resolveLanguage", () => {
  it("resolves the exact string 'Spanish' to es", () => {
    expect(resolveLanguage("Spanish")).toBe("es");
  });

  it("resolves 'English' to en", () => {
    expect(resolveLanguage("English")).toBe("en");
  });

  it("defaults safely to en when the preference is missing or invalid", () => {
    expect(resolveLanguage(null)).toBe("en");
    expect(resolveLanguage(undefined)).toBe("en");
    expect(resolveLanguage("")).toBe("en");
    expect(resolveLanguage("spanish")).toBe("en"); // wrong case — not inferred
    expect(resolveLanguage("Mexican")).toBe("en"); // never inferred from nationality
    expect(resolveLanguage("es")).toBe("en"); // only the exact desktop value counts
  });
});

describe("t (translation dictionary)", () => {
  it("every key resolves to a non-empty string in both languages", () => {
    // Re-derive the key list from a representative sample plus a runtime
    // probe: since TranslationKey is a compile-time-only type, we import a
    // known key to anchor the type check, then iterate via a cast — the
    // actual completeness guarantee comes from TypeScript itself refusing
    // to compile TRANSLATIONS_ES if a key were missing (see i18n.ts).
    const sampleKeys: TranslationKey[] = [
      "loading",
      "offlineReconnecting",
      "statusIdle",
      "statusWorking",
      "statusOnBreak",
      "chooseJob",
      "current",
      "recentJobs",
      "noRecentJobs",
      "noActivitiesMessage",
      "stepXOfY",
      "noRowsMessage",
      "searchRowNumber",
      "noMatchingRows",
      "noRowsInPhase",
      "noCarriersMessage",
      "searchCarrier",
      "noMatchingCarriers",
      "starting",
      "confirm",
      "skipNoRow",
      "skipNoCarrier",
      "back",
      "backDrillDown",
      "cancel",
      "close",
      "finishWorkQuestion",
      "finishWorkConfirmMessage",
      "finishing",
      "finishWork",
      "keepWorking",
      "navHome",
      "navEndWork",
      "navStartBreak",
      "navEndBreak",
      "navStats",
      "statsTitle",
      "statsLoadError",
      "statsNoData",
      "statsHoursSuffix",
      "weekThisWeek",
      "weekLastWeek",
      "couldNotLoadStatus",
      "queuedChangesFailed",
      "somethingWentWrong",
      "mustBeOnlineToFinish",
      "couldNotReachServer",
      "couldNotFinishWork",
      "acknowledge",
      "acknowledging",
    ];
    for (const key of sampleKeys) {
      const en = t("en", key, { date: "x", count: 1, name: "x", step: 1, total: 2, activity: "x", duration: "x", n: 2 });
      const es = t("es", key, { date: "x", count: 1, name: "x", step: 1, total: 2, activity: "x", duration: "x", n: 2 });
      expect(en.length).toBeGreaterThan(0);
      expect(es.length).toBeGreaterThan(0);
    }
  });

  it("English and Spanish give genuinely different text for the same key", () => {
    expect(t("en", "chooseJob")).not.toBe(t("es", "chooseJob"));
    expect(t("en", "navHome")).toBe("Home");
    expect(t("es", "navHome")).toBe("Inicio");
    expect(t("en", "navStats")).toBe("Stats");
    expect(t("es", "navStats")).toBe("Estadísticas");
  });

  it("interpolates params without translating the interpolated value itself", () => {
    // The interpolated value here stands in for an activity name (admin
    // content) — t() must never transform it, only the surrounding
    // sentence.
    const en = t("en", "workedBeforeBreak", { activity: "Winding & Pruning", duration: "1:02:03" });
    const es = t("es", "workedBeforeBreak", { activity: "Winding & Pruning", duration: "1:02:03" });
    expect(en).toContain("Winding & Pruning");
    expect(es).toContain("Winding & Pruning");
    expect(en).not.toBe(es);
  });

  it("stepXOfY interpolates numeric step/total", () => {
    expect(t("en", "stepXOfY", { step: 1, total: 2 })).toBe("Step 1 of 2");
    expect(t("es", "stepXOfY", { step: 1, total: 2 })).toBe("Paso 1 de 2");
  });
});

describe("translateServerMessage", () => {
  it("never translates when the language is English", () => {
    expect(translateServerMessage("en", "greenhouseRowId is required for this activity")).toBe(
      "greenhouseRowId is required for this activity"
    );
  });

  it("translates every known server validation message for Spanish", () => {
    expect(translateServerMessage("es", "greenhouseRowId is required for this activity")).toBe(
      "Se requiere una fila para esta actividad"
    );
    expect(translateServerMessage("es", "carrierId is required for this activity")).toBe(
      "Se requiere un transportador para esta actividad"
    );
    expect(translateServerMessage("es", "No prior activity to resume")).toBe(
      "No hay una actividad anterior para reanudar"
    );
  });

  it("falls back to the original English text for an unrecognized server message", () => {
    const unknown = "Some brand-new server error string this dictionary has never seen";
    expect(translateServerMessage("es", unknown)).toBe(unknown);
    expect(translateServerMessage("en", unknown)).toBe(unknown);
  });
});

// The offline-cache and reassignment scenarios both hinge on the same real
// mechanism: WorkSessionContext derives `language` from
// DevicePairingContext's cachedEmployee, which lib/device.ts persists to
// localStorage on every successful /me response and reassignment
// acknowledgement. These tests exercise that actual persistence layer
// (not a mock of it) combined with resolveLanguage, rather than only
// testing resolveLanguage in isolation.
describe("offline-cached language and reassignment (via lib/device.ts)", () => {
  let device: typeof import("./device");

  beforeEach(async () => {
    (globalThis as { localStorage?: Storage }).localStorage = createFakeStorage();
    device = await import("./device");
  });

  it("a Spanish-preference employee's cached language survives being read back with no live server response", () => {
    device.setCachedEmployeeSummary({
      employeeId: "emp-1",
      firstName: "Maria",
      lastName: "Lopez",
      preferredLanguage: "Spanish",
      lastVerifiedAt: new Date().toISOString(),
    });

    // Simulates a fresh app load while offline: nothing calls setCachedEmployeeSummary
    // again, only the persisted read-back that HomeScreen's `!me && cachedEmployee`
    // branch and WorkSessionContext's `language` both rely on.
    const cached = device.getCachedEmployeeSummary();
    expect(resolveLanguage(cached?.preferredLanguage)).toBe("es");
  });

  it("an English-preference (or unset) employee's cached language defaults to English offline", () => {
    device.setCachedEmployeeSummary({
      employeeId: "emp-2",
      firstName: "John",
      lastName: "Smith",
      preferredLanguage: null,
      lastVerifiedAt: new Date().toISOString(),
    });
    expect(resolveLanguage(device.getCachedEmployeeSummary()?.preferredLanguage)).toBe("en");
  });

  it("a cached summary written before this field existed (preferredLanguage absent) still defaults safely to English", () => {
    // Simulates an old cache entry from before this feature shipped — the
    // field is optional (see CachedEmployeeSummary), so JSON.parse produces
    // an object with no preferredLanguage key at all, not `undefined`
    // explicitly set.
    localStorage.setItem(
      "labourlink_paired_employee",
      JSON.stringify({ employeeId: "emp-3", firstName: "Old", lastName: "Cache", lastVerifiedAt: "2020-01-01" })
    );
    expect(resolveLanguage(device.getCachedEmployeeSummary()?.preferredLanguage)).toBe("en");
  });

  it("reassignment: the language immediately reflects the new employee once the cache is overwritten", () => {
    // English-preference employee A, currently paired.
    device.setCachedEmployeeSummary({
      employeeId: "emp-A",
      firstName: "Alice",
      lastName: "Anderson",
      preferredLanguage: "English",
      lastVerifiedAt: new Date().toISOString(),
    });
    expect(resolveLanguage(device.getCachedEmployeeSummary()?.preferredLanguage)).toBe("en");

    // Acknowledging a reassignment (WorkSessionContext.acknowledgeReassignment)
    // overwrites the cache with the new employee's full record in one call —
    // never a partial patch — so this is the exact write this test performs.
    device.setCachedEmployeeSummary({
      employeeId: "emp-B",
      firstName: "Beatriz",
      lastName: "Barrios",
      preferredLanguage: "Spanish",
      lastVerifiedAt: new Date().toISOString(),
    });

    const afterReassignment = device.getCachedEmployeeSummary();
    expect(afterReassignment?.employeeId).toBe("emp-B");
    expect(resolveLanguage(afterReassignment?.preferredLanguage)).toBe("es");
  });
});
