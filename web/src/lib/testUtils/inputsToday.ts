import { vi } from "vitest";

// Inputs always opens on today in the organization's time zone (see
// InputsPage — it no longer reads a ?date= from the URL), so a test that
// needs the page on a particular day opens it with that day as "today", then
// lets the real clock carry on: the page keeps the day it opened on, exactly
// as it does when left open past midnight. Only Date is faked, and only
// during the initial render, so waitFor/userEvent timers stay real.
export function renderInputsOn<T>(date: string, doRender: () => T): T {
  vi.useFakeTimers({ toFake: ["Date"] });
  // 16:00 UTC is midday in Toronto under both EST and EDT.
  vi.setSystemTime(new Date(`${date}T16:00:00.000Z`));
  try {
    return doRender();
  } finally {
    vi.useRealTimers();
  }
}
