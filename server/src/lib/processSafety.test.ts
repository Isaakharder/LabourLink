// Tests the API's error containment (processSafety.ts, gracefulShutdown.ts):
//   - request level: an async route/middleware rejection — even one NOT
//     wrapped in asyncHandler, the bug class behind the 2026-10-10 outage —
//     answers 500 promptly instead of hanging or crashing, and never reaches
//     the process-level handler;
//   - a rejection outside any request is logged and the server keeps serving;
//   - a fatal uncaught exception is NOT swallowed: in-flight requests finish,
//     new connections are refused, and the process exits with code 1 so
//     Railway restarts it (real modules, in a child process).
//
// Run with: npm run test:process-safety
import express, { NextFunction, Request, Response } from "express";
import { AddressInfo } from "net";
import { spawn } from "child_process";
import path from "path";
import { asyncHandler } from "./asyncHandler";
import { installAsyncErrorForwarding, installProcessSafetyNet } from "./processSafety";

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

async function timedFetch(url: string, ms: number) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: ctl.signal });
    return { status: res.status, body: (await res.json().catch(() => null)) as any, ms: Date.now() - started, hung: false };
  } catch {
    return { status: 0, body: null, ms: Date.now() - started, hung: true };
  } finally {
    clearTimeout(t);
  }
}

async function inProcess() {
  const rejections: unknown[] = [];
  const fatals: unknown[] = [];
  installAsyncErrorForwarding();
  const uninstall = installProcessSafetyNet({
    log: (message, detail) => (message.includes("FATAL") ? fatals : rejections).push(detail),
    onFatal: (err) => fatals.push(err),
  });
  const handled: string[] = [];

  const app = express();
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  // The production bug: async middleware, no asyncHandler, failing lookup.
  const failingMiddleware = (async () => {
    throw new Error('column "map_phase_ids" does not exist');
  }) as unknown as express.RequestHandler;
  app.get("/unwrapped-middleware", failingMiddleware, (_req, res) => res.json({ unreachable: true }));
  app.get("/unwrapped-handler", (async () => {
    throw new Error("handler failed");
  }) as unknown as express.RequestHandler);
  app.get("/fails-after-response", (async (_req: Request, res: Response) => {
    res.json({ sent: true });
    throw new Error("failed after responding");
  }) as unknown as express.RequestHandler);
  app.get("/sync-throw", () => {
    throw new Error("sync failure");
  });
  app.get("/wrapped", asyncHandler(async () => {
    throw new Error("wrapped failure");
  }));
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    handled.push(String(err));
    if (res.headersSent) return next(err);
    res.status(500).json({ error: "Internal server error" });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    for (const route of ["/unwrapped-middleware", "/unwrapped-handler"]) {
      const r = await timedFetch(`${BASE}${route}`, 3000);
      check(!r.hung && r.status === 500 && r.body?.error === "Internal server error" && r.ms < 1000, `${route}: an unwrapped async rejection answers 500 promptly (no hang)`, r);
    }
    check(handled.some((h) => h.includes("map_phase_ids")), "the rejection reached the Express error handler (request level)", handled);

    const after = await timedFetch(`${BASE}/fails-after-response`, 3000);
    check(after.status === 200 && after.body?.sent === true, "a handler that fails after responding still delivers its response", after);
    const sync = await timedFetch(`${BASE}/sync-throw`, 3000);
    check(sync.status === 500, "a synchronous throw in a route still answers 500 (unchanged)", sync);
    const wrapped = await timedFetch(`${BASE}/wrapped`, 3000);
    check(wrapped.status === 500, "asyncHandler-wrapped routes still answer 500 once", wrapped);
    await new Promise((r) => setTimeout(r, 100));
    check(rejections.length === 0, "none of the request failures reached the process-level rejection handler", rejections.map(String));

    // A rejection outside any request (e.g. background work).
    void Promise.reject(new Error("background job failed"));
    await new Promise((r) => setTimeout(r, 100));
    check(rejections.length === 1 && String(rejections[0]).includes("background job failed"), "a rejection outside a request is logged by the safety net", rejections.map(String));
    const health = await timedFetch(`${BASE}/health`, 3000);
    check(health.status === 200, "the server keeps serving after it", health);
    check(fatals.length === 0, "no request failure or rejection was treated as fatal", fatals.map(String));
  } finally {
    uninstall();
    server.close();
  }
}

async function fatalChild() {
  const child = spawn(process.execPath, ["-r", "ts-node/register", path.join(__dirname, "processSafety.fatalChild.ts")], {
    cwd: path.join(__dirname, "..", ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const port = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`child didn't start: ${out}`)), 30000);
    const timer = setInterval(() => {
      const m = out.match(/PORT=(\d+)/);
      if (m) {
        clearInterval(timer);
        clearTimeout(t);
        resolve(m[1]);
      }
    }, 50);
  });
  const BASE = `http://127.0.0.1:${port}`;

  const slow = timedFetch(`${BASE}/slow`, 5000); // 800ms, in flight when the fatal hits
  await new Promise((r) => setTimeout(r, 50));
  const armed = await timedFetch(`${BASE}/fatal`, 3000); // throws uncaught 100ms later
  await new Promise((r) => setTimeout(r, 300));
  const afterFatal = await timedFetch(`${BASE}/slow`, 2000);
  const slowResult = await slow;
  // A swallowed fatal would leave the process running: fail clearly, then kill it.
  const code = await Promise.race([exit, new Promise<"still running">((r) => setTimeout(() => r("still running"), 10000))]);
  if (code === "still running") child.kill();

  check(armed.status === 200, "fatal child: armed", armed);
  check(slowResult.status === 200 && slowResult.body?.finished === true, "fatal: the request already in flight still completes (graceful)", slowResult);
  check(afterFatal.status === 0, "fatal: new connections are refused once shutting down", afterFatal);
  check(code === 1, "fatal: the process exits with code 1 so Railway restarts it (not swallowed)", { code });
  check(/FATAL uncaught exception/.test(out) && /simulated fatal bug/.test(out), "fatal: logged as FATAL with the error", out.slice(-400));
  check(/\[shutdown\] fatal uncaught exception/.test(out) && /all requests finished/.test(out), "fatal: went through graceful shutdown", out.slice(-400));
}

(async () => {
  await inProcess();
  await fatalChild();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
