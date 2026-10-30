import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { activityGroupsRemoved } from "../lib/legacyActivityGroups";

// Activity Groups were removed (see lib/legacyActivityGroups.ts): every
// former /api/activity-groups endpoint, read or write, now answers 410
// "refresh LabourLink" for a desktop page still running the old version.
const router = Router();

router.all("/", requireAuth, activityGroupsRemoved);
router.all("/*", requireAuth, activityGroupsRemoved);

export default router;
