// Scale Weighings -> Review allocation (server/src/routes/scaleProductivityAllocations.ts).
// Productivity reporting only: the official scale credit is shown, never changed.

export type AllocationStatus = "single" | "shared_auto" | "review" | "reviewed" | "manual" | "excluded";

export const ALLOCATION_STATUS_LABELS: Record<AllocationStatus, string> = {
  single: "One employee",
  shared_auto: "Shared automatically",
  review: "To review",
  reviewed: "Reviewed",
  manual: "Set by an administrator",
  excluded: "Excluded",
};

// Badge colours reuse the weighing status badges (scale-status-*).
export const ALLOCATION_STATUS_BADGE: Record<AllocationStatus, string> = {
  single: "credited",
  shared_auto: "credited",
  reviewed: "credited",
  manual: "credited",
  review: "needs_review",
  excluded: "voided",
};

export interface AllocationReason {
  code: string;
  label: string;
}

export interface AllocationContributor {
  employeeId: string;
  name: string;
  matchedMinutes: number;
  matchedSeconds: number;
  percent: number;
  proposedKg: number;
  countedKg: number | null; // null: the bin counts for nobody right now
  counted: boolean;
  scanned: boolean;
  otherJobMinutes: number;
  firstAt: string | null;
  lastAt: string | null;
}

export interface AllocationListBin {
  weighingId: string;
  bin: string;
  weighedAt: string;
  netKg: number;
  officialCredit: { id: string; name: string };
  status: AllocationStatus;
  decided: boolean;
  reasons: AllocationReason[];
  contributors: AllocationContributor[];
}

export interface AllocationList {
  date: string;
  jobs: { id: string; name: string }[];
  activityId: string | null;
  bins: AllocationListBin[];
}

export interface AllocationHistoryEntry {
  id: string;
  action: "confirm" | "override" | "exclude" | "reset";
  reason: string;
  previous: { action: string; method: string | null; shares: { employeeId: string; included: boolean; allocatedGrams: number }[] } | null;
  next: { action: string; method: string | null; shares: { employeeId: string; included: boolean; allocatedGrams: number }[] } | null;
  proposal: { netGrams: number; status: AllocationStatus; reasons: string[]; contributors: { employeeId: string; matchedSeconds: number; proposedGrams: number }[] };
  performed_at: string;
  performed_by: string;
}

export interface AllocationDetail {
  activityId: string;
  weighingId: string;
  bin: string;
  weighedAt: string;
  netKg: number;
  grossKg: number;
  tareKg: number;
  weighingStatus: string;
  officialCredit: { id: string; name: string } | null;
  version: number;
  decision: {
    action: "confirm" | "override" | "exclude";
    method: "proportional" | "manual" | null;
    reason: string;
    decidedAt: string;
    decidedBy: string;
    shares: { employeeId: string; name: string; included: boolean; matchedSeconds: number; allocatedGrams: number; allocatedKg: number }[];
  } | null;
  history: AllocationHistoryEntry[];
  allocatable: boolean;
  status: AllocationStatus;
  basis?: "single" | "shared_auto" | "reviewed_proportional" | "manual" | null;
  reasons: AllocationReason[];
  contributors: AllocationContributor[];
  fingerprint: string | null;
  loadStart: string | null;
}
