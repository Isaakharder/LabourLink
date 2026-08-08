// DTOs for the employee messaging feature — server/src/routes/messages.ts
// (desktop admin) and server/src/routes/mobileMessages.ts (mobile).

export type MessageStatus = "sent" | "pending" | "acknowledged";

export interface MessageSummary {
  id: string;
  messageText: string;
  createdByEmployeeId: string;
  createdByName: string;
  allEmployees: boolean;
  createdAt: string;
  recipientCount: number;
  acknowledgedCount: number;
  status: MessageStatus;
}

export interface MessageRecipientDetail {
  employeeId: string;
  employeeName: string;
  employeeActive: boolean;
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
