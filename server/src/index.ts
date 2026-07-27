import "dotenv/config";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import authRoutes from "./routes/auth";
import dashboardRoutes from "./routes/dashboard";
import diagnosticsRoutes from "./routes/diagnostics";
import healthRoutes from "./routes/health";

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
