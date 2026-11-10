// The one place message delivery states are put into words, for the desktop
// Message Details table, the desktop Messages list and the mobile send
// result. Each stage is kept separate on purpose — a recipient row existing
// is not "Sent", and a push service accepting a request is not "the phone
// got it":
//
//   saved      the recipient row exists; the phone gets it on its next fetch
//   push       what the server's notification attempt recorded
//   retrieved  the paired phone actually fetched it (delivered_at)
//   acknowledged the employee tapped Acknowledge
import type { MessageRecipientDetail, MessageSummary, MobileMessageSendResult, PushStatus } from "./messageTypes";

export function pushStatusLabel(pushStatus: PushStatus | null): string {
  switch (pushStatus) {
    case "accepted":
      return "Notification accepted by push service";
    case "no_device":
      return "No registered device for notifications";
    case "failed":
      return "Notification delivery failed";
    default:
      return "Not recorded";
  }
}

export function recipientProgressLabel(r: Pick<MessageRecipientDetail, "deliveredAt" | "acknowledgedAt">): string {
  if (r.acknowledgedAt) return "Acknowledged";
  if (r.deliveredAt) return "Retrieved by phone, not yet acknowledged";
  return "Saved for recipient, waiting for their phone";
}

export function messageListStatusLabel(m: Pick<MessageSummary, "status" | "recipientCount">): string {
  if (m.status === "acknowledged") return "All acknowledged";
  if (m.status === "pending") return "Awaiting acknowledgement";
  return m.recipientCount === 0 ? "No recipients" : "Saved";
}

// Desktop list column, e.g. "1 accepted · 2 no device". Blank (—) for
// servers older than migration 073, which don't return the counts.
export function notificationSummaryLabel(
  m: Pick<MessageSummary, "recipientCount" | "pushAcceptedCount" | "pushNoDeviceCount" | "pushFailedCount">
): string {
  if (m.pushAcceptedCount === undefined) return "—";
  const parts: string[] = [];
  if (m.pushAcceptedCount) parts.push(`${m.pushAcceptedCount} accepted`);
  if (m.pushNoDeviceCount) parts.push(`${m.pushNoDeviceCount} no device`);
  if (m.pushFailedCount) parts.push(`${m.pushFailedCount} failed`);
  const recorded = m.pushAcceptedCount + (m.pushNoDeviceCount ?? 0) + (m.pushFailedCount ?? 0);
  const unrecorded = m.recipientCount - recorded;
  if (unrecorded > 0) parts.push(`${unrecorded} not recorded`);
  return parts.join(" · ") || "—";
}

// Mobile send-result headline. Older servers only return the legacy counts,
// so the status is derived from those when notificationStatus is missing.
export function sendResultHeadline(result: MobileMessageSendResult): string {
  const status =
    result.notificationStatus ??
    (result.pushSucceeded >= result.recipientCount && result.recipientCount > 0
      ? "sent"
      : result.pushSucceeded === 0 && result.pushFailed === 0
        ? "no_device"
        : result.pushSucceeded === 0 && result.noActiveDeviceCount === 0
          ? "failed"
          : "partial");
  switch (status) {
    case "sent":
      return "Message saved and notification sent.";
    case "no_device":
      return "Message saved, but no registered device is available for notification.";
    case "failed":
      return "Message saved, but notification delivery failed.";
    case "in_progress":
      return "Message saved. Notification is still being sent.";
    default:
      return "Message saved. Notifications were sent to some recipients only.";
  }
}
