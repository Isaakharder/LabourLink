// Process-level safety net for promise rejections nobody handled.
//
// Node's default for an unhandled rejection is to terminate the process. For
// this API that turns ONE bad request into an outage for everyone — every
// phone, TV and office user — as on 2026-10-10, when a single unwrapped async
// middleware (fixed in routes/greenhouseLive.ts) crash-looped production.
// Every route is meant to go through asyncHandler, which turns a rejection
// into a 500 for that request; this only catches the case where that was
// missed. It logs the rejection loudly (with a stack, for Railway's logs) and
// keeps serving: the request that failed may get no response and time out,
// but nothing else is affected. Synchronous uncaught exceptions keep Node's
// default (crash and let Railway restart), since their state is less
// predictable.
export function installProcessSafetyNet(log: (message: string, reason: unknown) => void = console.error): () => void {
  const onRejection = (reason: unknown) => {
    log("[process] UNHANDLED PROMISE REJECTION — a route or job is missing asyncHandler/.catch; the API kept running:", reason);
  };
  process.on("unhandledRejection", onRejection);
  return () => {
    process.off("unhandledRejection", onRejection);
  };
}
