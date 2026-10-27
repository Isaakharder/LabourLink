// Mirrors App::snapshot() in scale/service/src/app.rs. Weights are integer grams.

export interface BinRef {
  carrierId: string;
  carrierName: string;
  tag: string;
  tareG: number;
}

export type BlockReason =
  | { code: "noTag" }
  | { code: "unknownTag"; tag: string }
  | { code: "multipleTags"; tags: string[] }
  | { code: "carrierInactive" }
  | { code: "tareMissing" }
  | { code: "recentlyWeighed"; secondsAgo: number }
  | { code: "indicatorNotGross" }
  | { code: "overload" }
  | { code: "underload" }
  | { code: "indicatorError" }
  | { code: "emptyBin"; netG: number }
  | { code: "saveFailed"; message: string };

export type Phase =
  | { phase: "starting" }
  | { phase: "idle" }
  | { phase: "settling"; bin: BinRef; startedMs: number }
  | { phase: "stabilizing"; bin: BinRef; sinceMs: number }
  | { phase: "awaitingRemoval"; reason: "recorded" | "startupLoad"; bin: BinRef | null; emptySinceMs: number | null }
  | { phase: "blocked"; reason: BlockReason; bin: BinRef | null; emptySinceMs: number | null };

export interface Reading {
  weightG: number | null;
  mode: "gross" | "net" | "unknown";
  motion: boolean;
  overload: boolean;
  underload: boolean;
  error: boolean;
}

export type AssignmentStatus = "unknown" | "credited" | "pending" | "needs_review" | "expired" | "voided";

export interface Weighing {
  id: string;
  carrierId: string;
  carrierName: string;
  rfidTag: string;
  grossG: number;
  tareG: number;
  netG: number;
  recordedAt: string;
  simulated: boolean;
  uploadState: "queued" | "sent" | "rejected";
  uploadAttempts: number;
  lastError: string | null;
  assignmentStatus: AssignmentStatus;
  employeeName: string | null;
  pendingUntil: string | null;
}

export interface LinkStatus {
  state: "connected" | "disconnected" | "simulated" | "simulated-offline" | "online" | "offline";
  detail: string;
}

export interface RigView {
  flags: {
    wobble: boolean;
    scaleOffline: boolean;
    rfidOffline: boolean;
    rfidRepeat: boolean;
    indicatorNet: boolean;
    overload: boolean;
  };
  tagOnScale: string | null;
  targetGrossG: number;
}

export interface Snapshot {
  mode: "simulation" | "live";
  simulated: boolean;
  stationName: string;
  phase: Phase;
  settleRemainingMs: number;
  removalRemainingMs: number;
  scaleOnline: boolean;
  reading: Reading | null;
  bin: BinRef | null;
  liveNetG: number | null;
  currentWeighing: Weighing | null;
  recent: Weighing[];
  lastTag: { tag: string; secondsAgo: number; carrierName: string | null } | null;
  connections: { scale: LinkStatus; rfid: LinkStatus; server: LinkStatus; serverLastOkAt: string | null };
  outbox: { queued: number; pending: number; attention: number };
  carrierCount: number;
  params: { settleMs: number; removalMs: number; minLoadG: number; duplicateGuardMs: number };
  rig: RigView | null;
}
