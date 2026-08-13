// Short, best-effort scan feedback — vibration plus a synthesized tone,
// matching "short vibration and/or sound where supported." Used by the
// Register Existing Tag admin screen's instant-registration path and
// HomeScreen's active-screen NFC row/bin switch. No bundled audio asset:
// every tone is synthesized with the Web Audio API so this has no extra
// dependency and nothing to fetch. Every call is wrapped in try/catch —
// this is purely an enhancement, never something that should throw or block
// the caller if the device/browser doesn't support one or both APIs.
//
// Success and error are deliberately distinct in both channels, not just
// louder/softer: success is two quick rising tones (louder — peak gain 0.6,
// up from the original single tone's 0.15 — so it cuts through greenhouse
// background noise) and a single short vibration; error is one lower,
// quieter tone and a distinct double-buzz vibration pattern, so an employee
// who isn't looking at the screen can tell success from failure by feel/ear
// alone. Both stay well under 300ms total — obvious, not an alarm.
//
// Loudness here is a ceiling, not a guarantee: on Android this still plays
// through the device's current media volume, so if it's turned all the way
// down the tone is inaudible no matter how high this file's own gain is —
// there's no API to override the user's hardware volume. Turning up media
// volume is the actual fix for "I can't hear the scan beep" in the field.

function getAudioContext(): AudioContext | null {
  const AudioContextClass =
    (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return AudioContextClass ? new AudioContextClass() : null;
}

// One short tone, starting `startOffset` seconds from now within the given
// context — a quick linear attack into an exponential decay (a real 0 gain
// start value breaks exponentialRampToValueAtTime, hence 0.0001) so it reads
// as a clean "beep" rather than a click or a sustained buzz.
function tone(ctx: AudioContext, freq: number, startOffset: number, duration: number, peakGain: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = freq;
  osc.connect(gain);
  gain.connect(ctx.destination);
  const startTime = ctx.currentTime + startOffset;
  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.exponentialRampToValueAtTime(peakGain, startTime + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
  osc.start(startTime);
  osc.stop(startTime + duration + 0.02);
}

export function playSuccessFeedback(): void {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(80);
    }
  } catch {
    // best-effort only
  }

  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    // Two quick rising tones (880Hz -> 1318.5Hz, a perfect fifth up) — a
    // clear "confirmed" chime, louder and more distinct than a single tone,
    // still under 250ms total.
    tone(ctx, 880, 0, 0.09, 0.6);
    tone(ctx, 1318.5, 0.1, 0.11, 0.6);
  } catch {
    // best-effort only
  }
}

export function playErrorFeedback(): void {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      // Double-buzz — distinct from success's single vibration by feel
      // alone, without needing to look at the screen.
      navigator.vibrate([60, 60, 60]);
    }
  } catch {
    // best-effort only
  }

  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    // One lower, quieter tone — deliberately softer than success (peak
    // gain 0.25 vs 0.6) so the two are never confused for one another.
    tone(ctx, 330, 0, 0.15, 0.25);
  } catch {
    // best-effort only
  }
}
