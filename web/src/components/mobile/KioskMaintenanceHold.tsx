import { ReactNode, useEffect, useRef } from "react";
import { openKioskMaintenance, useKioskDevice } from "../../lib/kiosk";

export const KIOSK_HOLD_MS = 5000;

// Hidden administrator entry on kiosk phones: press and hold the wrapped
// title for five seconds to open the native maintenance screen, which then
// demands the maintenance PIN before showing anything. On every non-kiosk
// device (personal Android, iOS, browser) this renders `children` exactly
// as-is — no wrapper element, no handlers — so nothing changes there.
export function KioskMaintenanceHold({ children }: { children: ReactNode }) {
  const kiosk = useKioskDevice();
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    []
  );

  if (!kiosk) return <>{children}</>;

  function start() {
    cancel();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      openKioskMaintenance().catch(() => {});
    }, KIOSK_HOLD_MS);
  }

  function cancel() {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }

  return (
    <div
      className="kiosk-hold"
      data-testid="kiosk-maintenance-hold"
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>
  );
}
