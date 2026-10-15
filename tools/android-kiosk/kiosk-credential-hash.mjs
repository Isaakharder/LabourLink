#!/usr/bin/env node
// Generates the value for LabourLink's `maintenance_credential` managed
// configuration (set per device in the EMM console). Output format matches
// web/android/app/src/main/java/.../kiosk/KioskCredential.java exactly:
//   pbkdf2-sha256$<iterations>$<base64 salt>$<base64 hash>
//
// The PIN is read from stdin (never a command-line argument, so it can't
// land in shell history or `ps`). Only the printed hash goes into the EMM;
// the PIN itself goes into the company password manager, per device.
//
//   node tools/android-kiosk/kiosk-credential-hash.mjs
//   (type the PIN, press Enter)
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

const ITERATIONS = 100_000;
const MIN = 6;
const MAX = 32;

export function encodeCredential(pin, salt = randomBytes(16), iterations = ITERATIONS) {
  if (!/^\d+$/.test(pin) || pin.length < MIN || pin.length > MAX) {
    throw new Error(`PIN must be ${MIN}-${MAX} digits`);
  }
  const hash = pbkdf2Sync(Buffer.from(pin, "utf8"), salt, iterations, 32, "sha256");
  return `pbkdf2-sha256$${iterations}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
  process.stderr.write(`Maintenance PIN (${MIN}-${MAX} digits): `);
  rl.once("line", (line) => {
    rl.close();
    try {
      process.stdout.write(encodeCredential(line.trim()) + "\n");
    } catch (e) {
      process.stderr.write(`\n${e.message}\n`);
      process.exit(1);
    }
  });
}
