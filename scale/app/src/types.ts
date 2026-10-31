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
  /** From the server: false while the station's credits were off (trial). */
  creditsLive: boolean | null;
}

export interface LinkStatus {
  /** unrecognized: the scale port is sending data the configured protocol can't parse. */
  state: "connected" | "disconnected" | "unrecognized" | "simulated" | "simulated-offline" | "online" | "offline";
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

export interface Proposal {
  id: string;
  tag: string;
  grossG: number;
  samplesG: number[];
  stableMs: number;
}

export type RegProblem =
  | { code: "noTag" }
  | { code: "multipleTags"; tags: string[] }
  | { code: "indicatorNotGross" }
  | { code: "overload" }
  | { code: "underload" }
  | { code: "indicatorError" };

export type RegPhase =
  | { phase: "clearScale"; emptySinceMs: number | null }
  | { phase: "ready" }
  | { phase: "measuring"; sinceMs: number }
  | { phase: "problem"; reason: RegProblem; emptySinceMs: number | null }
  | { phase: "proposed"; proposal: Proposal }
  | { phase: "saving"; proposal: Proposal }
  | { phase: "saved"; binName: string; rfidTag: string; tareG: number; emptySinceMs: number | null };

/** Register Bins, while it is open (weighing is paused). */
export interface RegistrationView {
  person: string;
  phase: RegPhase;
  reading: Reading | null;
  scaleOnline: boolean;
  settleRemainingMs: number;
  clearRemainingMs: number;
}

/** An existing LabourLink bin, as Register Bins sees it. */
export interface RegBin {
  id: string;
  name: string;
  rfidTag: string | null;
  tareWeightKg: number;
  isActive: boolean;
}

export interface Snapshot {
  /** hardware-test: real scale and RFID reader, test bins and the in-process test server. */
  mode: "simulation" | "hardware-test" | "live";
  /** True only in simulation mode (fake scale and reader, simulator drawer). */
  simulated: boolean;
  stationName: string;
  phase: Phase;
  settleRemainingMs: number;
  removalRemainingMs: number;
  /** Load returned before the scale confirmed empty for 2 s. */
  waitForZero: boolean;
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
  registration: RegistrationView | null;
  /** The station's credit switch on the server; false = trial (no credits). null until known. */
  creditsEnabled: boolean | null;
}
