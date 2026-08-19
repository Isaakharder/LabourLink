import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useWorkSession } from "../../context/WorkSessionContext";
import { api, ApiError } from "../../lib/api";
import { uuid } from "../../lib/uuid";
import { Avatar } from "../../components/employees/Avatar";
import { MobileMessageRecipient, MobileMessageSendResult } from "../../lib/messageTypes";

type RecipientMode = "all" | "selected";
type Step = "compose" | "confirm" | "result";

export function MessagesScreen() {
  const { me, handleApiError } = useWorkSession();
  const canSend = me?.employee.securityRole === "Administrator";

  const [step, setStep] = useState<Step>("compose");
  const [messageText, setMessageText] = useState("");
  const [recipientMode, setRecipientMode] = useState<RecipientMode>("all");
  const [employees, setEmployees] = useState<MobileMessageRecipient[] | null>(null);
  const [recipientsError, setRecipientsError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [validationError, setValidationError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [result, setResult] = useState<MobileMessageSendResult | null>(null);

  // Generated once per logical send attempt (when the confirmation step is
  // opened) and reused across a retry of that SAME attempt (e.g. tapping
  // "Try again" after a transient network failure) — never regenerated
  // until the admin goes back and re-opens confirmation, so a lost-response
  // retry can never create a second message. Same convention as
  // mobileTime.ts's idempotencyKey handling (WorkSessionContext.tsx).
  const idempotencyKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!canSend) return;
    api<{ employees: MobileMessageRecipient[] }>("/api/mobile/messages/recipients")
      .then((res) => setEmployees(res.employees))
      .catch((err) => {
        if (handleApiError(err)) return;
        if (err instanceof ApiError && err.status === 403) {
          setForbidden(true);
        } else {
          setRecipientsError(err instanceof ApiError ? err.message : "Could not load employees.");
        }
      });
  }, [canSend, handleApiError]);

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
  function selectAll() {
    setSelectedIds(new Set(filteredEmployees.map((e) => e.id)));
  }
  function clearAll() {
    setSelectedIds(new Set());
  }

  const recipientCount = recipientMode === "all" ? employees?.length ?? 0 : selectedIds.size;
  const selectedRecipients = useMemo(
    () => (employees ?? []).filter((e) => selectedIds.has(e.id)),
    [employees, selectedIds]
  );

  function openConfirm() {
    const trimmed = messageText.trim();
    if (!trimmed) {
      setValidationError("Message text is required.");
      return;
    }
    if (recipientCount === 0) {
      setValidationError(
        recipientMode === "selected" ? "Select at least one employee." : "There are no active employees to send to."
      );
      return;
    }
    setValidationError(null);
    idempotencyKeyRef.current = uuid();
    setStep("confirm");
  }

  async function send() {
    if (sending) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await api<MobileMessageSendResult>("/api/mobile/messages/send", {
        method: "POST",
        body: JSON.stringify({
          messageText: messageText.trim(),
          recipientMode,
          ...(recipientMode === "selected" ? { employeeIds: Array.from(selectedIds) } : {}),
          idempotencyKey: idempotencyKeyRef.current,
        }),
      });
      setResult(res);
      setStep("result");
    } catch (err) {
      if (handleApiError(err)) return;
      setSendError(err instanceof ApiError ? err.message : "Could not send this message.");
    } finally {
      setSending(false);
    }
  }

  function composeAnother() {
    setMessageText("");
    setRecipientMode("all");
    setSelectedIds(new Set());
    setSearch("");
    setResult(null);
    setSendError(null);
    idempotencyKeyRef.current = null;
    setStep("compose");
  }

  if (!canSend) {
    return (
      <div className="mobile-settings">
        <h1>Messages</h1>
        <Link to="/mobile/settings" className="mobile-action-button mobile-action-secondary">
          Back to Settings
        </Link>
        <p className="error-text">You don't have permission to view this page.</p>
      </div>
    );
  }

  return (
    <div className="mobile-settings mobile-messages-screen">
      <h1>Messages</h1>
      <Link to="/mobile/settings" className="mobile-action-button mobile-action-secondary">
        Back to Settings
      </Link>

      {forbidden && <p className="error-text">You don't have permission to view this page.</p>}
      {!forbidden && recipientsError && <p className="error-text">{recipientsError}</p>}

      {!forbidden && step === "compose" && (
        <section className="mobile-settings-device-section mobile-messages-compose">
          <h2>New message</h2>
          <textarea
            className="message-text-input"
            value={messageText}
            onChange={(e) => setMessageText(e.target.value)}
            placeholder="Write the message employees will see..."
            rows={4}
          />

          <div className="message-recipient-mode">
            <label>
              <input
                type="radio"
                name="mobileRecipientMode"
                checked={recipientMode === "all"}
                onChange={() => setRecipientMode("all")}
              />
              All employees
            </label>
            <label>
              <input
                type="radio"
                name="mobileRecipientMode"
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
              <div className="mobile-messages-select-actions">
                <button type="button" className="mobile-action-button mobile-action-secondary" onClick={selectAll}>
                  Select all
                </button>
                <button type="button" className="mobile-action-button mobile-action-secondary" onClick={clearAll}>
                  Clear all
                </button>
              </div>
              <div className="message-recipient-list">
                {!employees ? (
                  <p className="placeholder-page">Loading...</p>
                ) : filteredEmployees.length === 0 ? (
                  <p className="placeholder-page">No employees match.</p>
                ) : (
                  filteredEmployees.map((emp) => (
                    <label key={emp.id} className="message-recipient-item mobile-message-recipient-item">
                      <input type="checkbox" checked={selectedIds.has(emp.id)} onChange={() => toggleEmployee(emp.id)} />
                      <Avatar photoUrl={emp.photoUrl} firstName={emp.firstName} lastName={emp.lastName} size="small" />
                      <span>
                        {emp.firstName} {emp.lastName}
                      </span>
                      {!emp.hasActiveDevice && <span className="mobile-message-no-device">No device</span>}
                    </label>
                  ))
                )}
              </div>
            </div>
          )}

          <p className="message-recipient-count">
            {recipientCount} recipient{recipientCount === 1 ? "" : "s"} will receive this message.
          </p>

          {validationError && <p className="error-text">{validationError}</p>}

          <button type="button" className="mobile-action-button mobile-action-primary" onClick={openConfirm}>
            Review message
          </button>
        </section>
      )}

      {!forbidden && step === "confirm" && (
        <section className="mobile-settings-device-section mobile-messages-confirm">
          <h2>Review before sending</h2>
          <p className="mobile-messages-preview-text">{messageText.trim()}</p>
          <p className="mobile-messages-preview-meta">
            {recipientMode === "all"
              ? `To: All employees (${recipientCount})`
              : `To: Selected employees (${recipientCount})`}
          </p>
          {recipientMode === "selected" && (
            <ul className="mobile-messages-preview-list">
              {selectedRecipients.map((e) => (
                <li key={e.id}>
                  {e.firstName} {e.lastName}
                  {!e.hasActiveDevice && " (no device)"}
                </li>
              ))}
            </ul>
          )}

          {sendError && (
            <>
              <p className="error-text">{sendError}</p>
              <p className="mobile-settings-device-note">
                The message may already have been sent — tapping "Try again" is safe and will never create a
                duplicate.
              </p>
            </>
          )}

          <div className="mobile-confirm-actions">
            <button
              type="button"
              className="mobile-action-button mobile-action-primary"
              onClick={send}
              disabled={sending}
            >
              {sending ? "Sending..." : sendError ? "Try again" : "Confirm & Send"}
            </button>
            <button
              type="button"
              className="mobile-action-button mobile-action-secondary"
              onClick={() => setStep("compose")}
              disabled={sending}
            >
              Back to edit
            </button>
          </div>
        </section>
      )}

      {!forbidden && step === "result" && result && (
        <section className="mobile-settings-device-section mobile-messages-result">
          <h2>Message sent</h2>
          <p className="mobile-settings-device-note">
            Stored for {result.recipientCount} recipient{result.recipientCount === 1 ? "" : "s"}.
          </p>
          <p className="mobile-settings-device-note">
            Push notification delivered to {result.pushSucceeded} device{result.pushSucceeded === 1 ? "" : "s"}
            {result.pushFailed > 0 ? `, failed for ${result.pushFailed}` : ""}.
          </p>
          {result.noActiveDeviceCount > 0 && (
            <p className="mobile-settings-device-note">
              {result.noActiveDeviceCount} recipient{result.noActiveDeviceCount === 1 ? "" : "s"} with no assigned
              device will still see this message the next time LabourLink is open.
            </p>
          )}
          <button type="button" className="mobile-action-button mobile-action-primary" onClick={composeAnother}>
            Compose another message
          </button>
        </section>
      )}
    </div>
  );
}
