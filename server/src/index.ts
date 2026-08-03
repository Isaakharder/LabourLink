import "dotenv/config";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import activitiesRoutes from "./routes/activities";
import activityGroupsRoutes from "./routes/activityGroups";
import authRoutes from "./routes/auth";
import dashboardRoutes from "./routes/dashboard";
import devicesRoutes from "./routes/devices";
import diagnosticsRoutes from "./routes/diagnostics";
import employeesRoutes from "./routes/employees";
import greenhouseLayoutRoutes from "./routes/greenhouseLayout";
import healthRoutes from "./routes/health";
import inputsRoutes from "./routes/inputs";
import mobileTimeRoutes from "./routes/mobileTime";
import pairingRoutes from "./routes/pairing";
import passwordResetRoutes from "./routes/passwordReset";

const app = express();
const PORT = Number(process.env.PORT) || 4000;
const CORS_ORIGIN = (process.env.CORS_ORIGIN || "http://localhost:5173").split(
  ","
);

app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.use("/api/health", healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/diagnostics", diagnosticsRoutes);
app.use("/api/employees", employeesRoutes);
app.use("/api/activities", activitiesRoutes);
app.use("/api/activity-groups", activityGroupsRoutes);
app.use("/api/greenhouse-layout", greenhouseLayoutRoutes);
app.use("/api/pairing", pairingRoutes);
app.use("/api/password-reset", passwordResetRoutes);
app.use("/api/devices", devicesRoutes);
app.use("/api/mobile", mobileTimeRoutes);
app.use("/api/inputs", inputsRoutes);

// Safety net: any error forwarded via next(err) (see asyncHandler) lands
// here instead of crashing the process. Logged server-side; the client only
// gets a generic message so we never leak DB/internal details.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled request error:", err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`LabourLink API listening on port ${PORT}`);
});
