import { isNativePlatform } from "./platform";

// The policy is a static page (web/public/privacy.html), served without login
// by serve-static.js at /privacy. The browser/PWA build links to it on its own
// origin; the Android app's origin is https://localhost (bundled dist/, see
// capacitor.config.ts), so it links to the public site instead — Capacitor
// hands any non-localhost navigation to the system browser, so the employee
// sees the same live policy the store listings point at.
export const PUBLIC_PRIVACY_POLICY_URL = "https://labourlink.lltech.io/privacy";

export function privacyPolicyHref(): string {
  return isNativePlatform() ? PUBLIC_PRIVACY_POLICY_URL : "/privacy";
}
