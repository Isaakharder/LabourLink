import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import { MessageDetail } from "../../lib/messageTypes";

interface MessageDetailsModalProps {
  messageId: string;
  onClose: () => void;
}

function recipientStatus(deliveredAt: string | null, acknowledgedAt: string | null): string {
  if (acknowledgedAt) return "Acknowledged";
  if (deliveredAt) return "Delivered / Seen";
  return "Sent";
}

export function MessageDetailsModal({ messageId, onClose }: MessageDetailsModalProps) {
  const [detail, setDetail] = useState<MessageDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ message: MessageDetail }>(`/api/messages/${messageId}`)
      .then((res) => setDetail(res.message))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load this message"));
  }, [messageId]);

  return (
    <Modal title="Message Details" onClose={onClose} xl>
      {error && <p className="error-text">{error}</p>}
      {!detail ? (
        !error && <p className="placeholder-page">Loading...</p>
      ) : (
        <>
          <section className="employee-form-section">
            <p className="message-detail-text">{detail.messageText}</p>
            <p className="message-detail-meta">
              Sent by {detail.createdByName} · {new Date(detail.createdAt).toLocaleString()} ·{" "}
              {detail.allEmployees ? "All active employees at the time" : "Selected employees"}
            </p>
            <p className="message-detail-meta">
              {detail.acknowledgedCount} of {detail.recipientCount} acknowledged
            </p>
          </section>

          <section className="employee-form-section">
            <h3>Recipients</h3>
            <table className="employees-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Status</th>
                  <th>Acknowledged</th>
                </tr>
              </thead>
              <tbody>
                {detail.recipients.map((r) => (
                  <tr key={r.employeeId}>
                    <td>
                      {r.employeeName}
                      {!r.employeeActive && <span className="message-recipient-inactive"> (inactive)</span>}
                    </td>
                    <td>{recipientStatus(r.deliveredAt, r.acknowledgedAt)}</td>
                    <td>{r.acknowledgedAt ? new Date(r.acknowledgedAt).toLocaleString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </Modal>
  );
}
