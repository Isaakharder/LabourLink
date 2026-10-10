// Tests installProcessSafetyNet (processSafety.ts): an async route that is
// NOT wrapped in asyncHandler — the bug class behind the 2026-10-10 outage —
// must not take the server down once the safety net is installed. Without it
// the rejection terminates this process (which is how the test fails).
//
// Run with: npm run test:process-safety
import express, { NextFunction, Request, Response } from "express";
import { AddressInfo } from "net";
import { installProcessSafetyNet } from "./processSafety";

let pass = 0;
let fail = 0;
function check(condition: boolean, label: string, extra?: unknown) {
  if (condition) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL: ${label}`, extra !== undefined ? JSON.stringify(extra) : "");
  }
}

async function main() {
  const logged: unknown[] = [];
  const uninstall = installProcessSafetyNet((_message, reason) => logged.push(reason));

  const app = express();
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  // Deliberately unwrapped async middleware whose lookup fails.
  app.get(
    "/unwrapped",
    (async () => {
      throw new Error('column "map_phase_ids" does not exist');
    }) as unknown as express.RequestHandler,
    (_req: Request, res: Response) => res.json({ unreachable: true })
  );
  app.get("/wrapped-error", (_req: Request, _res: Response, next: NextFunction) => next(new Error("handled")));
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => res.status(500).json({ error: "Internal server error" }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    // The unwrapped request never gets a response; give it a moment.
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    await fetch(`${BASE}/unwrapped`, { signal: ctl.signal }).catch(() => null);
    clearTimeout(t);
    await new Promise((r) => setTimeout(r, 100));

    check(logged.length === 1 && String(logged[0]).includes("map_phase_ids"), "the unhandled rejection is logged with its error", logged.map(String));
    const health = await fetch(`${BASE}/health`).then((r) => r.status).catch(() => 0);
    check(health === 200, "the server keeps serving other requests after it", health);
    const second = await fetch(`${BASE}/wrapped-error`).then((r) => r.status).catch(() => 0);
    check(second === 500, "normal error handling still answers 500", second);
  } finally {
    uninstall();
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
