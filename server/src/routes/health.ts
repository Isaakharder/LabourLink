import { Router } from "express";

const router = Router();

// Liveness check only — must return immediately with no dependency on
// Supabase or anything else, so Railway's healthcheck can't be taken down
// by a slow/unreachable database. Deploy-time DB verification happens via
// `npm run migrate` and the login/dashboard smoke test, not this route.
router.get("/", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

export default router;
