import { useEffect, useState } from "react";

interface ActivityTimerProps {
  startedAt: string;
  // Already-accumulated seconds from earlier segments of the same
  // continuous job chain (e.g. worked time before a break) — added on top
  // of the live elapsed time since startedAt, not stored/incremented
  // locally. Server-computed; this component just displays it.
  offsetSeconds?: number;
  className?: string;
}

function elapsedSecondsSince(startedAt: string, offsetSeconds: number): number {
  return offsetSeconds + (Date.now() - new Date(startedAt).getTime()) / 1000;
}

export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours >= 1 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

// Purely a display of server time — startedAt (plus offsetSeconds) is the
// sole source of truth, recomputed on every tick rather than incremented
// locally, so nothing drifts and a prop change (switching activities, or
// resuming with a new accumulated offset) resets the display immediately
// instead of waiting for the next tick.
export function ActivityTimer({ startedAt, offsetSeconds = 0, className }: ActivityTimerProps) {
  const [elapsed, setElapsed] = useState(() => elapsedSecondsSince(startedAt, offsetSeconds));

  useEffect(() => {
    setElapsed(elapsedSecondsSince(startedAt, offsetSeconds));
    const interval = window.setInterval(() => {
      setElapsed(elapsedSecondsSince(startedAt, offsetSeconds));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [startedAt, offsetSeconds]);

  return <span className={className}>{formatElapsed(elapsed)}</span>;
}
