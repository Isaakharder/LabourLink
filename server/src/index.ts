import "dotenv/config";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import { parseCorsOrigins } from "./lib/corsOrigin";
import activitiesRoutes from "./routes/activities";
import activityGroupsRoutes from "./routes/activityGroups";
import authRoutes from "./routes/auth";
import breakProfilesRoutes from "./routes/breakProfiles";
import carrierCompletionsRoutes from "./routes/carrierCompletions";
import carriersRoutes from "./routes/carriers";
import dashboardRoutes from "./routes/dashboard";
import devicesRoutes from "./routes/devices";
import diagnosticsRoutes from "./routes/diagnostics";
import employeeBlocksRoutes from "./routes/employeeBlocks";
import employeesRoutes from "./routes/employees";
import employeeGroupsRoutes from "./routes/employeeGroups";
import workPermitsRoutes from "./routes/workPermits";
import employmentPeriodsRoutes from "./routes/employmentPeriods";
import greenhouseDisplaysRoutes from "./routes/greenhouseDisplays";
import greenhouseLayoutRoutes from "./routes/greenhouseLayout";
import greenhouseLiveRoutes from "./routes/greenhouseLive";
import healthRoutes from "./routes/health";
import inputsRoutes from "./routes/inputs";
import messagesRoutes from "./routes/messages";
import mobileMessagesRoutes from "./routes/mobileMessages";
import mobileEmployeesRoutes from "./routes/mobileEmployees";
import mobilePushRoutes from "./routes/mobilePush";
import mobileStatsRoutes from "./routes/mobileStats";
import mobileSyncConflictsRoutes from "./routes/mobileSyncConflicts";
import mobileTimeRoutes from "./routes/mobileTime";
import integrationsRoutes from "./routes/integrations";
import nfcTagsRoutes from "./routes/nfcTags";
import pairingRoutes from "./routes/pairing";
import reviewerPairingRoutes from "./routes/reviewerPairing";
import passwordResetRoutes from "./routes/passwordReset";
import plantDensitiesRoutes from "./routes/plantDensities";
import reportsRoutes from "./routes/reports";
import rowCompletionsRoutes from "./routes/rowCompletions";
import { installAsyncErrorForwarding, installProcessSafetyNet } from "./lib/processSafety";
import { createGracefulShutdown } from "./lib/gracefulShutdown";

const app = express();
const PORT = Number(process.env.PORT) || 4000;
const CORS_ORIGIN = parseCorsOrigins(process.env.CORS_ORIGIN);

// Request-level containment: any async route/middleware rejection becomes
// next(err) -> the error handler below -> a 500 for that request, instead of
// a hung request or a crashed process (lib/processSafety.ts).
installAsyncErrorForwarding();

app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.use("/api/health", healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/diagnostics", diagnosticsRoutes);
app.use("/api/employees", employeesRoutes);
app.use("/api/employees", workPermitsRoutes);
app.use("/api/employment-periods", employmentPeriodsRoutes);
app.use("/api/employee-blocks", employeeBlocksRoutes);
app.use("/api/employee-groups", employeeGroupsRoutes);
app.use("/api/plant-densities", plantDensitiesRoutes);
app.use("/api/row-completions", rowCompletionsRoutes);
app.use("/api/activities", activitiesRoutes);
app.use("/api/activity-groups", activityGroupsRoutes);
app.use("/api/break-profiles", breakProfilesRoutes);
app.use("/api/carriers", carriersRoutes);
app.use("/api/carrier-completions", carrierCompletionsRoutes);
app.use("/api/greenhouse-layout", greenhouseLayoutRoutes);
app.use("/api/greenhouse", greenhouseLiveRoutes);
app.use("/api/greenhouse/displays", greenhouseDisplaysRoutes);
app.use("/api/pairing", pairingRoutes);
app.use("/api/pairing", reviewerPairingRoutes);
app.use("/api/password-reset", passwordResetRoutes);
app.use("/api/devices", devicesRoutes);
app.use("/api/mobile", mobileTimeRoutes);
app.use("/api/mobile", mobileMessagesRoutes);
app.use("/api/mobile/employees", mobileEmployeesRoutes);
app.use("/api/mobile", mobilePushRoutes);
app.use("/api/mobile", mobileStatsRoutes);
app.use("/api/mobile/tags", nfcTagsRoutes);
app.use("/api/mobile-sync", mobileSyncConflictsRoutes);
app.use("/api/messages", messagesRoutes);
app.use("/api/inputs", inputsRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api/integrations", integrationsRoutes);

// Safety net: any error forwarded via next(err) (see asyncHandler) lands
// here instead of crashing the process. Logged server-side; the client only
// gets a generic message so we never leak DB/internal details.
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  console.error("Unhandled request error:", err);
  // A handler that failed after responding: let Express close the
  // connection rather than trying to send a second response.
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Internal server error" });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`LabourLink API listening on port ${PORT}`);
});

// Graceful shutdown (lib/gracefulShutdown.ts): on SIGTERM from a Railway
// deploy, finish in-flight requests before exiting (2026-10-10: a deploy
// used to cut a bulk speed review off mid-batch). A fatal uncaught exception
// uses the same path with exit code 1 and a shorter grace, so Railway's
// ON_FAILURE restart policy starts a fresh process.
const SHUTDOWN_GRACE_MS = 25_000;
const FATAL_SHUTDOWN_GRACE_MS = 10_000;
const shutdown = createGracefulShutdown(server, SHUTDOWN_GRACE_MS);
process.on("SIGTERM", () => shutdown("SIGTERM received"));
process.on("SIGINT", () => shutdown("SIGINT received"));

// Rejections outside any request are logged and the API keeps running;
// uncaught exceptions are never swallowed — graceful shutdown, exit 1,
// restart (lib/processSafety.ts).
installProcessSafetyNet({ onFatal: () => shutdown("fatal uncaught exception", 1, FATAL_SHUTDOWN_GRACE_MS) });
