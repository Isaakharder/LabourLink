// Short, best-effort success feedback for the Register Existing Tag admin
// screen's instant-registration path (see RegisterExistingTagScreen.tsx) —
// a brief vibration plus a synthesized beep, matching "short vibration
// and/or success sound where supported." No bundled audio asset: the beep
// is synthesized with the Web Audio API so this has no extra dependency and
// nothing to fetch. Every call is wrapped in try/catch — this is purely an
// enhancement, never something that should throw or block the caller if the
// device/browser doesn't support one or both APIs.
export function playRegistrationSuccessFeedback(): void {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(80);
    }
  } catch {
    // best-effort only
  }

  try {
    const AudioContextClass =
      (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.2);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
  } catch {
    // best-effort only
  }
}
