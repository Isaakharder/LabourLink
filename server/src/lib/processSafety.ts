// Error containment for the API process (2026-10-10 outage follow-up: one
// unwrapped async middleware turned a failed DB query into a crash on every
// TV poll and took the whole API down). Three layers, most specific first:
//
// 1. installAsyncErrorForwarding — request level. Express 4 ignores the
//    promise an async handler returns, so a rejection never reaches error
//    middleware: the request hangs or the process dies. This makes every
//    route/middleware's rejection call next(err), so the failed request gets
//    the normal 500 from index.ts's error handler. asyncHandler remains the
//    convention; this covers the route that forgets it.
// 2. unhandledRejection — last resort for rejections NOT tied to a request
//    (background work). Logged loudly; the API keeps serving.
// 3. uncaughtException — never swallowed. A synchronous exception that
//    escaped everything may have left the process in a bad state: log it as
//    fatal and let the caller shut down gracefully (stop accepting, give
//    in-flight requests a short grace) and exit non-zero, so Railway's
//    ON_FAILURE restart policy brings up a fresh process.
import { NextFunction, Request, Response } from "express";

// Express 4's router Layer (stable internal module; express-async-errors
// patches the same method). Typed loosely on purpose.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Layer = require("express/lib/router/layer") as {
  prototype: {
    handle: (req: Request, res: Response, next: NextFunction) => unknown;
    handle_request: (req: Request, res: Response, next: NextFunction) => void;
  };
};

let asyncForwardingInstalled = false;

export function installAsyncErrorForwarding(): void {
  if (asyncForwardingInstalled) return;
  asyncForwardingInstalled = true;
  // Same as Express 4.22's own handle_request, plus forwarding a returned
  // promise's rejection to next(err).
  Layer.prototype.handle_request = function handleRequest(this: typeof Layer.prototype, req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return next(); // error-handling middleware: not called here
    try {
      const result = fn(req, res, next) as { then?: unknown } | undefined;
      if (result && typeof result.then === "function") {
        (result as Promise<unknown>).then(undefined, (err: unknown) =>
          next(err ?? new Error("Async route handler rejected without a reason"))
        );
      }
    } catch (err) {
      next(err);
    }
  };
}

export interface ProcessSafetyOptions {
  // Graceful shutdown for a fatal exception; must end the process with a
  // non-zero exit code. Defaults to an immediate process.exit(1).
  onFatal?: (err: unknown) => void;
  log?: (message: string, detail: unknown) => void;
}

export function installProcessSafetyNet(opts: ProcessSafetyOptions = {}): () => void {
  const log = opts.log ?? ((message: string, detail: unknown) => console.error(message, detail));
  let fatalSeen = false;

  const onRejection = (reason: unknown) => {
    log("[process] Unhandled promise rejection outside a request — logged, the API keeps running:", reason);
  };
  const onException = (err: unknown) => {
    // Any non-zero exit lets Railway restart us, even if shutdown stalls.
    process.exitCode = 1;
    if (fatalSeen) {
      log("[process] Second fatal exception during shutdown — exiting now:", err);
      process.exit(1);
    }
    fatalSeen = true;
    log("[process] FATAL uncaught exception — shutting down for a restart:", err);
    if (opts.onFatal) opts.onFatal(err);
    else process.exit(1);
  };

  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);
  return () => {
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
  };
}
