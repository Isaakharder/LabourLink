import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../../lib/api";
import { MessageSummary } from "../../../lib/messageTypes";
import { SendMessageModal } from "../../../components/messages/SendMessageModal";
import { MessageDetailsModal } from "../../../components/messages/MessageDetailsModal";

function truncate(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function statusLabel(status: MessageSummary["status"]): string {
  if (status === "acknowledged") return "All acknowledged";
  if (status === "pending") return "Pending";
  return "Sent";
}

export function MessagesTab() {
  const [messages, setMessages] = useState<MessageSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [detailsId, setDetailsId] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ messages: MessageSummary[] }>("/api/messages")
      .then((res) => {
        setMessages(res.messages);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "Could not load messages");
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section className="setup-section">
      <div className="employees-toolbar">
        <span className="employees-count">
          {messages ? `${messages.length} message${messages.length === 1 ? "" : "s"}` : ""}
        </span>
        <button type="button" className="employees-add-button" onClick={() => setSendOpen(true)}>
          Send Message
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {!messages ? (
        <p>Loading...</p>
      ) : messages.length === 0 ? (
        <p className="placeholder-page">No messages sent yet.</p>
      ) : (
        <table className="employees-table">
          <thead>
            <tr>
              <th>Message</th>
              <th>Sent</th>
              <th>Recipients</th>
              <th>Acknowledged</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {messages.map((m) => (
              <tr key={m.id}>
                <td>{truncate(m.messageText)}</td>
                <td>{new Date(m.createdAt).toLocaleString()}</td>
                <td>{m.recipientCount}</td>
                <td>
                  {m.acknowledgedCount} / {m.recipientCount}
                </td>
                <td>{statusLabel(m.status)}</td>
                <td>
                  <div className="employee-row-actions">
                    <button type="button" onClick={() => setDetailsId(m.id)}>
                      View details
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {sendOpen && (
        <SendMessageModal
          onClose={() => setSendOpen(false)}
          onSent={() => {
            setSendOpen(false);
            load();
          }}
        />
      )}

      {detailsId && <MessageDetailsModal messageId={detailsId} onClose={() => setDetailsId(null)} />}
    </section>
  );
}
