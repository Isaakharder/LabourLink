// Presentation rules for the weighing screen, kept pure so they're unit-testable.
import type { Phase, Snapshot, Weighing } from "./types";

export function kg(grams: number | null | undefined): string {
  if (grams === null || grams === undefined) return "—";
  const sign = grams < 0 ? "−" : "";
  return `${sign}${(Math.abs(grams) / 1000).toFixed(2)}`;
}

export type Tone = "ready" | "working" | "done" | "warn" | "error";

export interface Headline {
  tone: Tone;
  title: string;
  detail: string;
}

function blockedHeadline(p: Extract<Phase, { phase: "blocked" }>): Headline {
  const r = p.reason;
  const bin = p.bin?.carrierName;
  switch (r.code) {
    case "noTag":
      return { tone: "warn", title: "Bin tag not detected", detail: "Hold the bin's RFID tag near the reader" };
    case "unknownTag":
      return { tone: "error", title: "Unregistered RFID tag", detail: `Tag ${r.tag} is not linked to a bin. An administrator can register it.` };
    case "multipleTags":
      return { tone: "error", title: "More than one bin detected", detail: "Weigh one bin at a time. Remove the bins from the scale." };
    case "carrierInactive":
      return { tone: "error", title: `${bin} is inactive`, detail: "This bin is deactivated in LabourLink and cannot be weighed" };
    case "tareMissing":
      return { tone: "error", title: `${bin} has no tare weight`, detail: "Set the bin's tare weight in LabourLink before weighing it" };
    case "recentlyWeighed":
      return { tone: "warn", title: `${bin} was just weighed`, detail: "Not recorded again. Remove the bin from the scale." };
    case "indicatorNotGross":
      return { tone: "error", title: "Indicator is not showing gross weight", detail: "The station only records gross weight. Ask a supervisor." };
    case "overload":
      return { tone: "error", title: "Scale overload", detail: "Remove weight from the scale" };
    case "underload":
      return { tone: "error", title: "Scale underload", detail: "Check the scale is clear and zeroed" };
    case "indicatorError":
      return { tone: "error", title: "Indicator error", detail: "Check the scale indicator display" };
    case "emptyBin":
      return { tone: "warn", title: `${bin} looks empty`, detail: `Net ${kg(r.netG)} kg is below the minimum. Not recorded.` };
    case "saveFailed":
      return { tone: "error", title: "Weighing NOT saved", detail: "The station could not store this weighing. Remove the bin and call a supervisor." };
  }
}

export function headline(s: Snapshot): Headline {
  if (!s.scaleOnline && s.phase.phase !== "starting") {
    return { tone: "error", title: "Scale not responding", detail: "No data from the scale indicator. Weighing is paused." };
  }
  const p = s.phase;
  switch (p.phase) {
    case "starting":
      return { tone: "working", title: "Connecting to scale…", detail: "Waiting for the first reading" };
    case "idle":
      return { tone: "ready", title: "Ready", detail: "Place one bin on the scale" };
    case "settling":
      return { tone: "working", title: "Settling…", detail: "Keep the bin still on the scale" };
    case "stabilizing":
      return { tone: "working", title: "Waiting for a stable weight", detail: "Keep the bin still; do not touch the scale" };
    case "awaitingRemoval":
      if (p.reason === "startupLoad") {
        return { tone: "warn", title: "Remove the bin to begin", detail: "The scale had weight on it when the station started" };
      }
      return { tone: "done", title: "Weight recorded", detail: "Remove the bin. The next bin can go on after the scale clears." };
    case "blocked":
      return blockedHeadline(p);
  }
}

export interface EmployeeLine {
  name: string;
  note: string;
  tone: "credited" | "pending" | "review" | "neutral";
}

/** What to show for "Employee": only a server-verified assignment is a name. */
export function employeeLine(w: Weighing | null, phase: Phase): EmployeeLine {
  if (!w) {
    if (phase.phase === "settling" || phase.phase === "stabilizing") {
      return { name: "Verified after weighing", note: "Credit comes from the picker's own bin scan", tone: "neutral" };
    }
    return { name: "—", note: "", tone: "neutral" };
  }
  if (w.uploadState === "queued") {
    return { name: "Saved on this station", note: "Employee will be matched when the LabourLink server is reachable", tone: "pending" };
  }
  if (w.uploadState === "rejected") {
    return { name: "Not accepted by server", note: w.lastError ?? "", tone: "review" };
  }
  switch (w.assignmentStatus) {
    case "credited":
      return { name: w.employeeName ?? "Credited", note: "Verified bin scan", tone: "credited" };
    case "pending":
      return { name: "Awaiting employee assignment", note: `No verified bin scan yet. Held until ${shortTime(w.pendingUntil)} (24 h).`, tone: "pending" };
    case "needs_review":
      return { name: "Needs review", note: "More than one possible picker. Nobody credited until a supervisor reviews it.", tone: "review" };
    case "expired":
      return { name: "Unassigned", note: "No verified bin scan within 24 hours. Kept for supervisor review.", tone: "review" };
    case "voided":
      return { name: "Voided", note: "", tone: "review" };
    default:
      return { name: "Checking assignment…", note: "", tone: "neutral" };
  }
}

export function shortTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

export function clockTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function statusLabel(w: Weighing): { text: string; tone: EmployeeLine["tone"] } {
  const e = employeeLine(w, { phase: "idle" });
  if (w.uploadState === "queued") return { text: "Queued", tone: "pending" };
  if (e.tone === "credited") return { text: e.name, tone: "credited" };
  if (w.assignmentStatus === "pending") return { text: "Awaiting assignment", tone: "pending" };
  return { text: e.name, tone: e.tone };
}
