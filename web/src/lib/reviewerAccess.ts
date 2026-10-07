import { api } from "./api";
import { getOrCreateDeviceIdentifier, normalizeReviewerApiUrl, setReviewerApiUrl } from "./device";

// App-store reviewer access. LabourLink's demo "organization" is a separate
// deployment with its own database of fictional records (see
// server/src/routes/reviewerPairing.ts). Pairing with a reviewer code:
//   1. asks the normal (production) API where the demo API lives — only a
//      public URL comes back, never a credential;
//   2. redeems the code against the demo API;
//   3. only then switches this phone to the demo API, permanently for this
//      install (REVIEWER_API_URL_KEY in lib/device.ts).
// No credential is built into the app: the code is typed in by the reviewer
// and checked server-side, and can be revoked or rotated at any time.

interface ReviewerTargetResponse {
  apiUrl: string;
}

interface ReviewerPairResponse {
  paired: boolean;
  employee: { firstName: string; lastName: string };
}

export async function pairWithReviewerCode(code: string): Promise<ReviewerPairResponse["employee"]> {
  const target = await api<ReviewerTargetResponse>("/api/pairing/reviewer-target");
  const demoApiUrl = normalizeReviewerApiUrl(target.apiUrl);
  if (!demoApiUrl) throw new Error("Reviewer access is not available right now.");

  const res = await api<ReviewerPairResponse>("/api/pairing/reviewer", {
    method: "POST",
    baseUrl: demoApiUrl,
    body: JSON.stringify({ deviceIdentifier: getOrCreateDeviceIdentifier(), code }),
  });
  setReviewerApiUrl(demoApiUrl);
  return res.employee;
}
