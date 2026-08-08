import { FormEvent, useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import { MessageSummary } from "../../lib/messageTypes";

interface SendMessageModalProps {
  onClose: () => void;
  onSent: () => void;
}

interface EmployeeOption {
  id: string;
  firstName: string;
  lastName: string;
}

type RecipientMode = "all" | "selected";

export function SendMessageModal({ onClose, onSent }: SendMessageModalProps) {
  const [messageText, setMessageText] = useState("");
  const [recipientMode, setRecipientMode] = useState<RecipientMode>("all");
  const [employees, setEmployees] = useState<EmployeeOption[] | null>(null);
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    api<{ employees: EmployeeOption[] }>("/api/employees?status=active")
      .then((res) => setEmployees(res.employees))
      .catch(() => setEmployees([]));
  }, []);

  const searchTerm = search.trim().toLowerCase();
  const filteredEmployees = (employees ?? []).filter((e) =>
    `${e.firstName} ${e.lastName}`.toLowerCase().includes(searchTerm)
  );

  function toggleEmployee(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const recipientCount = recipientMode === "all" ? employees?.length ?? 0 : selectedIds.size;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setFieldErrors({});

    const trimmed = messageText.trim();
    if (!trimmed) {
      setFieldErrors({ messageText: "Message text is required" });
      return;
    }
    if (recipientMode === "selected" && selectedIds.size === 0) {
      setError("Select at least one employee.");
      return;
    }

    setSubmitting(true);
    try {
      await api<{ message: MessageSummary }>("/api/messages", {
        method: "POST",
        body: JSON.stringify({
          messageText: trimmed,
          recipientMode,
          ...(recipientMode === "selected" ? { employeeIds: Array.from(selectedIds) } : {}),
        }),
      });
      onSent();
    } catch (err) {
      if (err instanceof ApiError && err.errors) {
        setFieldErrors(err.errors);
      } else {
        setError(err instanceof ApiError ? err.message : "Could not send this message");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Send Message" onClose={onClose} xl>
      <form onSubmit={handleSubmit} className="employee-form" noValidate>
        {error && <p className="error-text">{error}</p>}

        <section className="employee-form-section">
          <label>
            Message text *
            <textarea
              className="message-text-input"
              value={messageText}
              onChange={(e) => setMessageText(e.target.value)}
              placeholder="Write the message employees will see..."
              rows={4}
              required
            />
            {fieldErrors.messageText && <span className="field-error">{fieldErrors.messageText}</span>}
          </label>
        </section>

        <section className="employee-form-section">
          <h3>Recipients</h3>
          <div className="message-recipient-mode">
            <label>
              <input
                type="radio"
                name="recipientMode"
                checked={recipientMode === "all"}
                onChange={() => setRecipientMode("all")}
              />
              All active employees
            </label>
            <label>
              <input
                type="radio"
                name="recipientMode"
                checked={recipientMode === "selected"}
                onChange={() => setRecipientMode("selected")}
              />
              Selected employees
            </label>
          </div>

          {recipientMode === "selected" && (
            <div className="message-recipient-picker">
              <input
                type="text"
                className="message-recipient-search"
                placeholder="Search employees..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div className="message-recipient-list">
                {!employees ? (
                  <p className="placeholder-page">Loading...</p>
                ) : filteredEmployees.length === 0 ? (
                  <p className="placeholder-page">No employees match.</p>
                ) : (
                  filteredEmployees.map((emp) => (
                    <label key={emp.id} className="message-recipient-item">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(emp.id)}
                        onChange={() => toggleEmployee(emp.id)}
                      />
                      {emp.firstName} {emp.lastName}
                    </label>
                  ))
                )}
              </div>
            </div>
          )}

          <p className="message-recipient-count">
            {recipientCount} recipient{recipientCount === 1 ? "" : "s"} will receive this message.
          </p>
        </section>

        <div className="employee-form-actions">
          <button type="button" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="employee-form-save" disabled={submitting || recipientCount === 0}>
            {submitting ? "Sending..." : "Send Message"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
