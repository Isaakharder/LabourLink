// DTOs for the employee messaging feature — server/src/routes/messages.ts
// (desktop admin) and server/src/routes/mobileMessages.ts (mobile).

export type MessageStatus = "sent" | "pending" | "acknowledged";

// employee_message_recipients.push_status — null = not recorded (still in
// progress, or sent before migration 073). "accepted" means the push
// service accepted the request, never that the phone displayed it.
export type PushStatus = "accepted" | "no_device" | "failed";

export interface MessageSummary {
  id: string;
  messageText: string;
  createdByEmployeeId: string;
  createdByName: string;
  allEmployees: boolean;
  createdAt: string;
  recipientCount: number;
  acknowledgedCount: number;
  // Optional: absent from servers older than migration 073.
  retrievedCount?: number;
  pushAcceptedCount?: number;
  pushNoDeviceCount?: number;
  pushFailedCount?: number;
  status: MessageStatus;
}

export interface MessageRecipientDetail {
  employeeId: string;
  employeeName: string;
  employeeActive: boolean;
  savedAt?: string;
  pushStatus?: PushStatus | null;
  pushAttemptedAt?: string | null;
  pushSentAt: string | null;
  deliveredAt: string | null;
  acknowledgedAt: string | null;
}

export interface MessageDetail extends MessageSummary {
  recipients: MessageRecipientDetail[];
}

// GET /api/mobile/messages/outstanding — one entry per unacknowledged
// message for the paired employee, oldest first.
export interface OutstandingMessage {
  recipientId: string;
  messageId: string;
  messageText: string;
  createdAt: string;
  senderName: string;
}

// GET /api/mobile/messages/recipients — mobile Messages screen's compose
// candidate list (Administrator-only). Every active employee, same
// definition resolveRecipients() uses for "all employees" — not limited to
// who's currently clocked in.
export interface MobileMessageRecipient {
  id: string;
  firstName: string;
  lastName: string;
  photoUrl: string | null;
  // True only when the employee has an assigned device with an active push
  // registration. A paired phone without notifications enabled is false,
  // and still gets the message the next time LabourLink opens or syncs.
  hasActiveDevice: boolean;
}

// POST /api/mobile/messages/send — mobile Messages screen's send result.
// recipientCount is always the number of rows actually stored (the message
// is committed before push is attempted, so this is never affected by push
// outcome); pushSucceeded/pushFailed/noActiveDeviceCount describe delivery
// only, never whether the message itself was saved.
export interface MobileMessageSendResult {
  messageId: string;
  recipientCount: number;
  // Present from servers with migration 073; counts are employees.
  notificationStatus?: "sent" | "no_device" | "failed" | "partial" | "in_progress";
  pushAcceptedCount?: number;
  pushFailedCount?: number;
  noDeviceCount?: number;
  inProgressCount?: number;
  replayed?: boolean;
  pushSucceeded: number;
  pushFailed: number;
  noActiveDeviceCount: number;
}
