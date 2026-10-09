import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The iOS build declares ITSAppUsesNonExemptEncryption = false (see the
// comment beside it in ios/App/App/Info.plist). That declaration is only
// true while SQLCipher's database encryption stays switched off — this
// fails loudly if any change turns it on without revisiting export
// compliance first.
const webRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const appSources = sourceFiles(join(webRoot, "src")).map((path) => ({ path, text: readFileSync(path, "utf8") }));

describe("iOS export compliance (no SQLite encryption)", () => {
  it("opens every SQLite connection unencrypted", () => {
    const calls = appSources.flatMap(({ path, text }) =>
      [...text.matchAll(/\.createConnection\(([^)]*)\)/g)].map((m) => ({ path, args: m[1] }))
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const { path, args } of calls) {
      expect(args, path).toMatch(/,\s*false\s*,\s*"no-encryption"/);
    }
  });

  it("never sets or changes an encryption secret", () => {
    for (const { path, text } of appSources) {
      expect(text, path).not.toMatch(/setEncryptionSecret|changeEncryptionSecret|"secret"|"encryption"/);
    }
  });

  it("keeps iosIsEncryption off in capacitor.config.ts", () => {
    const config = readFileSync(join(webRoot, "capacitor.config.ts"), "utf8");
    expect(config).toMatch(/iosIsEncryption:\s*false/);
  });

  it("matches the Info.plist declaration", () => {
    const plist = readFileSync(join(webRoot, "ios/App/App/Info.plist"), "utf8");
    expect(plist).toMatch(/<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/);
  });
});
