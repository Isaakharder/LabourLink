import { describe, expect, it } from "vitest";
import {
  messageListStatusLabel,
  notificationSummaryLabel,
  pushStatusLabel,
  recipientProgressLabel,
  sendResultHeadline,
} from "./messageStatus";
import type { MobileMessageSendResult } from "./messageTypes";

const base: MobileMessageSendResult = {
  messageId: "m",
  recipientCount: 1,
  pushSucceeded: 0,
  pushFailed: 0,
  noActiveDeviceCount: 0,
};

describe("recipientProgressLabel", () => {
  it("never calls a bare recipient row 'Sent'", () => {
    const label = recipientProgressLabel({ deliveredAt: null, acknowledgedAt: null });
    expect(label).not.toMatch(/sent/i);
    expect(label).toBe("Saved for recipient, waiting for their phone");
  });

  it("distinguishes retrieved-by-phone from acknowledged", () => {
    expect(recipientProgressLabel({ deliveredAt: "2026-11-10T21:08:38Z", acknowledgedAt: null })).toMatch(/Retrieved/);
    expect(
      recipientProgressLabel({ deliveredAt: "2026-11-10T21:08:38Z", acknowledgedAt: "2026-11-10T21:11:26Z" })
    ).toBe("Acknowledged");
  });
});

describe("pushStatusLabel", () => {
  it("labels each recorded push outcome distinctly", () => {
    expect(pushStatusLabel("accepted")).toBe("Notification accepted by push service");
    expect(pushStatusLabel("no_device")).toBe("No registered device for notifications");
    expect(pushStatusLabel("failed")).toBe("Notification delivery failed");
    expect(pushStatusLabel(null)).toBe("Not recorded");
  });

  it("never claims the phone received it just because the push service accepted it", () => {
    expect(pushStatusLabel("accepted")).not.toMatch(/delivered|received/i);
  });
});

describe("messageListStatusLabel", () => {
  it("shows a message nobody has acknowledged as awaiting acknowledgement, not a delivery state", () => {
    expect(messageListStatusLabel({ status: "pending", recipientCount: 1 })).toBe("Awaiting acknowledgement");
    expect(messageListStatusLabel({ status: "acknowledged", recipientCount: 1 })).toBe("All acknowledged");
  });
});

describe("notificationSummaryLabel", () => {
  it("summarizes the per-recipient outcomes", () => {
    expect(
      notificationSummaryLabel({ recipientCount: 4, pushAcceptedCount: 1, pushNoDeviceCount: 2, pushFailedCount: 1 })
    ).toBe("1 accepted · 2 no device · 1 failed");
  });

  it("shows recipients a pre-migration message never recorded", () => {
    expect(
      notificationSummaryLabel({ recipientCount: 3, pushAcceptedCount: 1, pushNoDeviceCount: 0, pushFailedCount: 0 })
    ).toBe("1 accepted · 2 not recorded");
  });

  it("falls back to a dash for an older server", () => {
    expect(notificationSummaryLabel({ recipientCount: 1 })).toBe("—");
  });
});

describe("sendResultHeadline", () => {
  it("names each outcome the sender needs to know", () => {
    expect(sendResultHeadline({ ...base, notificationStatus: "sent" })).toBe("Message saved and notification sent.");
    expect(sendResultHeadline({ ...base, notificationStatus: "no_device" })).toBe(
      "Message saved, but no registered device is available for notification."
    );
    expect(sendResultHeadline({ ...base, notificationStatus: "failed" })).toBe(
      "Message saved, but notification delivery failed."
    );
    expect(sendResultHeadline({ ...base, notificationStatus: "partial" })).toMatch(/some recipients/);
    expect(sendResultHeadline({ ...base, notificationStatus: "in_progress" })).toMatch(/still being sent/);
  });

  it("always says the message was saved, whatever push did", () => {
    for (const s of ["sent", "no_device", "failed", "partial", "in_progress"] as const) {
      expect(sendResultHeadline({ ...base, notificationStatus: s })).toMatch(/^Message saved/);
    }
  });

  it("derives the outcome from legacy counts when an older server omits notificationStatus", () => {
    expect(sendResultHeadline({ ...base, noActiveDeviceCount: 1 })).toMatch(/no registered device/);
    expect(sendResultHeadline({ ...base, pushFailed: 1 })).toMatch(/delivery failed/);
    expect(sendResultHeadline({ ...base, pushSucceeded: 1 })).toBe("Message saved and notification sent.");
  });
});
