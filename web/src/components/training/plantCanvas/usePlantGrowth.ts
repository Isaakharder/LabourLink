import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { activeHeadIds, buildPlantModel, easeInOut, type SplitMode } from "./plantGeometry";
import { FALL_DURATION_MS, applyCuts, type CutRecord } from "./plantCuts";

// Drives everything the trainer animates: the `growth` value the plant is
// drawn from (0→1 the initial split, +1 per "Grow 30 cm"), cuts and their
// falling pieces.
//
//   start ──split(n)──▶ growing ──▶ grown ⇄ cycling (grow(): +1 cycle)
//                                    │  ⇅
//                                    │ falling (cut(): piece drops out)
//                                  undo()
//                                    ▼
//   start ◀── undoing: plays history backwards — each cycle shrinks away,
//             and cut pieces fly back into place at the moment they were cut
//
// Growing heads are tracked explicitly by the model (one per live tip: both
// children of every fork get one; a cut removes only those above it), and
// Grow is only available while some head survives. Transitions are guarded by a ref so clicks in the same frame
// can't overlap; one requestAnimationFrame loop at a time, cancelled on
// unmount. With prefers-reduced-motion every transition is immediate.

export type GrowthPhase = "start" | "growing" | "grown" | "cycling" | "falling" | "undoing";

export const GROW_DURATION_MS = 3000;
export const GROW_CYCLE_MS = 3000;
export const UNDO_DURATION_MS = 1500;
export const UNDO_CYCLE_MS = 700;
export const REWIND_DURATION_MS = 600;

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface PlantGrowthState {
  phase: GrowthPhase;
  growth: number;
  splitMode: SplitMode;
  /** Completed "Grow 30 cm" cycles. */
  cycles: number;
  /** Cuts made so far, in order (stable array between cuts). */
  cuts: CutRecord[];
  /** Fall progress (0…1) per cut; 1 = fallen out of the canvas. */
  fallProgress: number[];
  /** Growing heads still alive (not cut off). */
  activeHeads: string[];
  split: (mode: SplitMode) => void;
  /** Adds one growth cycle; false (no-op) unless grown, idle and alive. */
  grow: () => boolean;
  /** Returns false (and does nothing) unless the plant is grown and idle. */
  cut: (stemId: string, s: number) => boolean;
  undo: () => void;
}

export function usePlantGrowth(): PlantGrowthState {
  const [phase, setPhase] = useState<GrowthPhase>("start");
  const [growth, setGrowth] = useState(0);
  const [splitMode, setSplitMode] = useState<SplitMode>(2);
  const [cuts, setCuts] = useState<CutRecord[]>([]);
  const [fallProgress, setFallProgress] = useState<number[]>([]);

  const phaseRef = useRef<GrowthPhase>("start");
  const frameRef = useRef<number | null>(null);
  // Mirrors of state for synchronous decisions inside event handlers.
  const growthRef = useRef(0);
  const modeRef = useRef<SplitMode>(2);
  const cutsRef = useRef<CutRecord[]>([]);

  const goTo = useCallback((next: GrowthPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);
  const putGrowth = useCallback((g: number) => {
    growthRef.current = g;
    setGrowth(g);
  }, []);
  const putCuts = useCallback((next: CutRecord[], progress: number[]) => {
    cutsRef.current = next;
    setCuts(next);
    setFallProgress(progress);
  }, []);

  /** Runs one timed animation, calling onFrame with linear time 0…1. */
  const run = useCallback((durationMs: number, onFrame: (t: number) => void, onDone: () => void) => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    let startTime: number | null = null;
    const step = (now: number) => {
      if (startTime === null) startTime = now;
      const t = Math.min(1, (now - startTime) / durationMs);
      onFrame(t);
      if (t < 1) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        frameRef.current = null;
        onDone();
      }
    };
    frameRef.current = requestAnimationFrame(step);
  }, []);

  const split = useCallback(
    (mode: SplitMode) => {
      if (phaseRef.current !== "start") return;
      modeRef.current = mode;
      setSplitMode(mode);
      if (prefersReducedMotion()) {
        putGrowth(1);
        goTo("grown");
        return;
      }
      goTo("growing");
      run(
        GROW_DURATION_MS,
        (t) => putGrowth(easeInOut(t)),
        () => {
          putGrowth(1);
          goTo("grown");
        }
      );
    },
    [goTo, putGrowth, run]
  );

  const grow = useCallback(() => {
    if (phaseRef.current !== "grown") return false;
    if (activeHeadIds(growthRef.current, modeRef.current, cutsRef.current).length === 0) return false;
    const from = Math.round(growthRef.current);
    const to = from + 1;
    if (prefersReducedMotion()) {
      putGrowth(to);
      return true;
    }
    goTo("cycling");
    run(
      GROW_CYCLE_MS,
      (t) => putGrowth(from + easeInOut(t)),
      () => {
        putGrowth(to);
        goTo("grown");
      }
    );
    return true;
  }, [goTo, putGrowth, run]);

  const cut = useCallback(
    (stemId: string, s: number) => {
      if (phaseRef.current !== "grown") return false;
      const at = growthRef.current;
      const previous = cutsRef.current;
      // Snapshot what falls: everything connected above the cut, as the
      // plant is right now.
      const model = buildPlantModel(at, modeRef.current, previous);
      const fresh = { stemId, s };
      const piece = applyCuts(model, [...previous, fresh]).pieces.find((p) => p.cut === fresh);
      if (!piece) return false;
      const record: CutRecord = { stemId, s, at, piece };
      const index = previous.length;
      const reduced = prefersReducedMotion();
      putCuts([...previous, record], [...previous.map(() => 1), reduced ? 1 : 0]);
      if (reduced) return true;
      goTo("falling");
      const setMine = (p: number) => setFallProgress((prev) => prev.map((v, i) => (i === index ? p : v)));
      run(FALL_DURATION_MS, setMine, () => {
        setMine(1);
        goTo("grown");
      });
      return true;
    },
    [goTo, putCuts, run]
  );

  const undo = useCallback(() => {
    if (phaseRef.current !== "grown") return;
    if (prefersReducedMotion()) {
      putCuts([], []);
      putGrowth(0);
      goTo("start");
      return;
    }
    goTo("undoing");
    // Play history backwards: at each cycle boundary, rewind the cuts made
    // there (their pieces fly back into place), then shrink that cycle away.
    const step = (level: number) => {
      const current = cutsRef.current;
      const here = current.map((c, i) => (c.at === level ? i : -1)).filter((i) => i >= 0);
      const shrink = () => {
        if (level <= 0) {
          putGrowth(0);
          goTo("start");
          return;
        }
        const to = level - 1;
        run(
          level === 1 ? UNDO_DURATION_MS : UNDO_CYCLE_MS,
          (t) => putGrowth(level - (level - to) * easeInOut(t)),
          () => {
            putGrowth(to);
            step(to);
          }
        );
      };
      if (!here.length) {
        shrink();
        return;
      }
      run(
        REWIND_DURATION_MS,
        (t) => setFallProgress((prev) => prev.map((v, i) => (here.includes(i) ? 1 - easeInOut(t) : v))),
        () => {
          const remaining = current.filter((_, i) => !here.includes(i));
          putCuts(remaining, remaining.map(() => 1));
          shrink();
        }
      );
    };
    step(Math.round(growthRef.current));
  }, [goTo, putCuts, putGrowth, run]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    },
    []
  );

  // Live tips, recomputed only when idle (not on every animation frame).
  const idle = phase === "grown" || phase === "start";
  const activeHeads = useMemo(
    () => (idle && growth > 0 ? activeHeadIds(growth, splitMode, cuts) : []),
    [idle, growth, splitMode, cuts]
  );
  const cycles = Math.max(0, Math.floor(growth - 1 + 1e-9));

  return { phase, growth, splitMode, cycles, cuts, fallProgress, activeHeads, split, grow, cut, undo };
}
