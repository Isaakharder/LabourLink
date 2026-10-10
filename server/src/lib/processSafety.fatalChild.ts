// Child process for processSafety.test.ts's fatal-exception case: the real
// installAsyncErrorForwarding + installProcessSafetyNet + createGracefulShutdown
// wired exactly as index.ts wires them, on a tiny app. Prints its port, then
// throws an uncaught exception FATAL_AFTER_MS later while a slow request is in
// flight. Not a test by itself.
import express from "express";
import { AddressInfo } from "net";
import { installAsyncErrorForwarding, installProcessSafetyNet } from "./processSafety";
import { createGracefulShutdown } from "./gracefulShutdown";

installAsyncErrorForwarding();
const app = express();
app.get("/slow", (_req, res) => {
  setTimeout(() => res.json({ finished: true }), 800);
});
app.get("/fatal", (_req, res) => {
  res.json({ armed: true });
  // Escapes every handler: a synchronous throw from a timer callback.
  setTimeout(() => {
    throw new Error("simulated fatal bug");
  }, 100);
});
const server = app.listen(0, "127.0.0.1", () => {
  console.log(`PORT=${(server.address() as AddressInfo).port}`);
});
const shutdown = createGracefulShutdown(server, 25_000);
installProcessSafetyNet({ onFatal: () => shutdown("fatal uncaught exception", 1, 3_000) });
