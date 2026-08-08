import { Capacitor } from "@capacitor/core";

export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}

// True only when running as an installed PWA (Home Screen / standalone
// window) — as opposed to a plain browser tab. Used to decide what the
// "Enable notifications" step on SettingsScreen should try/explain: iOS
// Safari only supports Web Push for a standalone-launched PWA, never a
// regular tab, so this distinction matters there specifically (Chrome/
// desktop browsers support it either way).
export function isInstalledPwa(): boolean {
  if (isNativePlatform()) return false;
  const standaloneMedia =
    typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches;
  // iOS Safari's own non-standard flag — `display-mode: standalone` isn't
  // reliably reported there even when actually installed.
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  return standaloneMedia || iosStandalone;
}

export function isWebPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}
