// Pure derivation of the mobile sync indicator's state — the single place
// HomeScreen's connection-bar and SettingsScreen's Sync section both decide
// what to show, so the two can't drift into showing different things for
// the same underlying situation (they used to: HomeScreen never showed a
// "Sync problem" state at all, and each computed its offline/pending text
// slightly differently). Matches the plan's four states exactly: Synced /
// N pending / Offline — N pending / Sync problem.
export type SyncIndicatorState = "synced" | "pending" | "offline" | "problem";

export interface SyncIndicatorInput {
  online: boolean;
  pending: number;
  // True once syncEngine.ts has failed at least two attempts in a row with
  // no success in between (see hasSyncProblem) — deliberately not "any
  // failure at all," since a single failed attempt during ordinary
  // reconnect jitter isn't yet something worth alarming anyone about.
  syncProblem: boolean;
}

// 'problem' takes priority even while offline (a device that was already
// failing to sync before losing connectivity is still a "problem" once it
// reconnects and keeps failing) — 'offline' only wins when connectivity,
// not sync health, is the actual blocker.
export function computeSyncIndicatorState({ online, pending, syncProblem }: SyncIndicatorInput): SyncIndicatorState {
  if (syncProblem) return "problem";
  if (!online) return "offline";
  if (pending > 0) return "pending";
  return "synced";
}
