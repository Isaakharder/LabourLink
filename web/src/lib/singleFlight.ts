// Wraps an async function so overlapping calls made while one is still in
// flight all resolve to that same underlying call instead of each starting
// their own. Only the call that actually *starts* the in-flight promise has
// its arguments used — a caller that arrives while one is already running
// gets that same pending promise back, not a second call with its own
// arguments. That's the right behavior for what this is used for: FCM
// re-registration on every app resume (push.ts), where an overlapping
// caller wants "whatever the in-progress attempt produces," not a second
// concurrent native call chain that would race with the first (e.g. one
// call's removeAllListeners() wiping another's just-added listeners).
export function singleFlight<Args extends unknown[], T>(
  fn: (...args: Args) => Promise<T>
): (...args: Args) => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return (...args: Args) => {
    if (inFlight) return inFlight;
    inFlight = fn(...args).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
