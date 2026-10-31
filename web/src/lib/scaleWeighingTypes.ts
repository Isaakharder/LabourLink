// Shapes returned by GET /api/scale-weighings (server/src/routes/scaleWeighings.ts).

export type ScaleWeighingStatus = "pending" | "credited" | "needs_review" | "expired" | "voided";

export interface ScaleWeighingRow {
  id: string;
  weighedAt: string;
  bin: { id: string; name: string };
  rfidTag: string;
  grossKg: number;
  tareKg: number;
  netKg: number;
  employee: { id: string; name: string } | null;
  status: ScaleWeighingStatus;
  // False while the station's credits were off (trial): never an employee credit.
  creditsLive: boolean;
  isDuplicate: boolean;
  countsForProduction: boolean;
  matchReason: string | null;
  pendingUntil: string | null;
  stationName: string;
  flagCount: number;
}

export interface ScaleWeighingDay {
  date: string;
  totals: {
    netKg: number;
    binsWeighed: number;
    creditedNetKg: number;
    credited: number;
    pending: number;
    needsReview: number;
    neverCredited: number;
    duplicates: number;
    voided: number;
    trial: number;
  };
  weighings: ScaleWeighingRow[];
  filters: { bins: { id: string; name: string }[]; employees: { id: string; name: string }[] };
}

export interface ScaleWeighingDetail extends Omit<ScaleWeighingRow, "flagCount"> {
  stationWeighingId: string;
  receivedAt: string;
  samplesKg: number[];
  countsAsCredit: boolean;
  resolvedAt: string | null;
  history: {
    kind: string;
    fromStatus: string | null;
    toStatus: string | null;
    reason: string | null;
    at: string;
    employeeName: string | null;
    actorName: string | null;
  }[];
  claims: { employeeName: string; occurredAt: string; receivedAt: string; eventType: string; deviceName: string | null }[];
  flags: { kind: "competing" | "late_conflict"; employeeName: string; occurredAt: string; receivedAt: string }[];
  corrections: {
    action: "void";
    reason: string;
    previousStatus: string;
    previousEmployeeName: string | null;
    performedAt: string;
    performedBy: string;
  }[];
}

export const STATUS_LABELS: Record<ScaleWeighingStatus, string> = {
  pending: "Pending",
  credited: "Credited",
  needs_review: "Needs review",
  expired: "Expired",
  voided: "Voided",
};
