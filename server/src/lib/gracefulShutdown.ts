import { Server } from "http";

// Graceful shutdown for the API (index.ts). Railway sends SIGTERM to the
// previous deployment when a new one goes live (and SIGKILLs it after
// deploy.drainingSeconds — see railway.json); a fatal uncaught exception uses
// the same path with a non-zero exit code so Railway's ON_FAILURE restart
// policy starts a fresh process. Stop accepting new connections, let
// in-flight requests finish, then exit; force the exit after the grace period.
export function createGracefulShutdown(server: Server, defaultGraceMs: number, log: (msg: string) => void = console.log) {
  let shuttingDown = false;
  return function shutdown(reason: string, exitCode = 0, graceMs = defaultGraceMs) {
    if (exitCode !== 0) process.exitCode = exitCode;
    if (shuttingDown) {
      // Already draining (e.g. SIGTERM) and now a fatal error: stop at once.
      if (exitCode !== 0) process.exit(exitCode);
      return;
    }
    shuttingDown = true;
    log(`[shutdown] ${reason} — finishing in-flight requests`);
    server.close(() => {
      log("[shutdown] all requests finished");
      process.exit(exitCode);
    });
    // Keep-alive sockets hold close() open: close the idle ones now, and keep
    // closing connections as their in-flight requests finish (otherwise each
    // one lingers until its keep-alive timeout or the grace period).
    server.closeIdleConnections();
    setInterval(() => server.closeIdleConnections(), 100).unref();
    setTimeout(() => {
      log("[shutdown] grace period over — exiting");
      process.exit(exitCode);
    }, graceMs).unref();
  };
}
