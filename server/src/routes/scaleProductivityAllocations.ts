// Scale Weighings -> Review allocation (Administrator only): how weighed
// bins' kilograms are shared between their pickers for kg/hour
// (lib/scaleProductivityAllocations.ts, 078). Productivity reporting only:
// official scale credits are never read for or changed by these routes.
//
//   GET  /api/scale-productivity-allocations?date=&activityId=      one day's shared / to-review / decided bins
//   GET  /api/scale-productivity-allocations/:weighingId?activityId= one bin: contributors, proposal, decision, history
//   POST /api/scale-productivity-allocations/:weighingId/decision    confirm | override | exclude | reset
import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { decideAllocation, DecisionAction, getAllocationDetail, listAllocations, scaleKgJobs, todayLocal } from "../lib/scaleProductivityAllocations";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();
router.use(requireAuth, requireRole("Administrator"));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ACTIONS: DecisionAction[] = ["confirm", "override", "exclude", "reset"];

// The kg/hour Job to work on: the one asked for, or the only/first one.
async function resolveJob(raw: unknown): Promise<{ jobs: { id: string; name: string }[]; jobId: string | null; bad: boolean }> {
  const jobs = await scaleKgJobs();
  if (typeof raw === "string" && raw) {
    if (!UUID_RE.test(raw) || !jobs.some((j) => j.id === raw)) return { jobs, jobId: null, bad: true };
    return { jobs, jobId: raw, bad: false };
  }
  return { jobs, jobId: jobs[0]?.id ?? null, bad: false };
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const date = typeof req.query.date === "string" && DATE_RE.test(req.query.date) ? req.query.date : todayLocal();
    const { jobs, jobId, bad } = await resolveJob(req.query.activityId);
    if (bad) return res.status(400).json({ error: "activityId must be a job that shows kilograms/hour" });
    if (!jobId) return res.json({ date, jobs, activityId: null, bins: [] });
    res.json({ date, jobs, activityId: jobId, bins: await listAllocations(jobId, date) });
  })
);

router.get(
  "/:weighingId",
  asyncHandler(async (req, res) => {
    if (!UUID_RE.test(req.params.weighingId)) return res.status(400).json({ error: "Invalid weighing id" });
    const { jobId, bad } = await resolveJob(req.query.activityId);
    if (bad || !jobId) return res.status(400).json({ error: "No job shows kilograms/hour" });
    const detail = await getAllocationDetail(jobId, req.params.weighingId);
    if (!detail) return res.status(404).json({ error: "Weighing not found" });
    res.json({ activityId: jobId, ...detail });
  })
);

router.post(
  "/:weighingId/decision",
  asyncHandler(async (req, res) => {
    if (!UUID_RE.test(req.params.weighingId)) return res.status(400).json({ error: "Invalid weighing id" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const { jobId, bad } = await resolveJob(b.activityId);
    if (bad || !jobId) return res.status(400).json({ error: "activityId must be a job that shows kilograms/hour" });
    const requestId = typeof b.requestId === "string" && UUID_RE.test(b.requestId) ? b.requestId : null;
    if (!requestId) return res.status(400).json({ error: "requestId must be a UUID" });
    if (typeof b.action !== "string" || !ACTIONS.includes(b.action as DecisionAction)) return res.status(400).json({ error: "Unknown action" });
    const reason = typeof b.reason === "string" ? b.reason.trim() : "";
    if (reason.length < 3) return res.status(400).json({ error: "Give a reason (at least 3 characters)" });
    if (!Number.isInteger(b.expectedVersion) || (b.expectedVersion as number) < 0) return res.status(400).json({ error: "expectedVersion must be a whole number" });
    if (typeof b.expectedFingerprint !== "string" || !b.expectedFingerprint) return res.status(400).json({ error: "expectedFingerprint is required" });
    let shares: { employeeId: string; included: boolean; allocatedKg?: number | null }[] | undefined;
    if (b.action === "override") {
      if (!Array.isArray(b.shares)) return res.status(400).json({ error: "shares are required to override" });
      shares = [];
      for (const s of b.shares as any[]) {
        if (!s || typeof s.employeeId !== "string" || !UUID_RE.test(s.employeeId) || typeof s.included !== "boolean") {
          return res.status(400).json({ error: "Each share needs an employeeId and included" });
        }
        if (s.allocatedKg != null && typeof s.allocatedKg !== "number") return res.status(400).json({ error: "allocatedKg must be a number" });
        shares.push({ employeeId: s.employeeId, included: s.included, allocatedKg: s.allocatedKg ?? null });
      }
    }
    const r = await decideAllocation(
      {
        weighingId: req.params.weighingId,
        jobId,
        requestId,
        action: b.action as DecisionAction,
        reason: reason.slice(0, 500),
        expectedVersion: b.expectedVersion as number,
        expectedFingerprint: b.expectedFingerprint,
        shares,
      },
      req.employee!.id
    );
    if (!r.ok) return res.status(r.status).json({ error: r.error, code: r.code });
    res.json({ ok: true, replay: r.replay, version: r.version });
  })
);

export default router;
