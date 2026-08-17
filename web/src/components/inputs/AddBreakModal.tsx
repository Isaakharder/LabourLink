import { FormEvent, useEffect, useMemo, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import { formatDateLong, combineDateAndTimeToUtcIso, toTimeInputValue } from "../../lib/timezone";
import { EmployeeBreakItemOption } from "../../lib/inputsTypes";
import { BreakPreviewRun, describeBreakSplitEffect } from "../../lib/breakSplitPreview";

const MIN_REASON_LENGTH = 3;
// Sentinel <select> value for "not one of the assigned profile's scheduled
// items" — a real break_profile_items id is always a uuid, so this can
// never collide with one.
const CUSTOM_VALUE = "__custom__";

interface AddBreakModalProps {
  employeeId: string;
  employeeName: string;
  date: string;
  // Today's already-loaded activity runs — used only to preview what
  // adding this break will do (split/trim/remove an existing activity)
  // before submitting. The server (planBreakInsertion, inputs.ts) is the
  // real authority on whether the break is accepted; this is a heads-up,
  // not a second implementation of the overlap logic.
  runs: BreakPreviewRun[];
  onClose: () => void;
  onCreated: () => void;
}

// Creates a new break using the exact same model a phone-recorded break
// uses (server/src/routes/inputs.ts's POST /breaks: entry_type = 'break',
// is_paid/break_profile_item_id set the same way mobileTime.ts's
// break/start sets them) so it flows through every existing paid/unpaid
// total and reconciliation calculation with no special-casing.
export function AddBreakModal({ employeeId, employeeName, date, runs, onClose, onCreated }: AddBreakModalProps) {
  const [items, setItems] = useState<EmployeeBreakItemOption[] | null>(null);
  const [breakProfileName, setBreakProfileName] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedValue, setSelectedValue] = useState<string>("");
  const [customIsPaid, setCustomIsPaid] = useState<"paid" | "unpaid">("unpaid");
  const [startTime, setStartTime] = useState(() => toTimeInputValue(new Date().toISOString()));
  const [endTime, setEndTime] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api<{ breakProfile: { id: string; name: string } | null; items: EmployeeBreakItemOption[] }>(
      `/api/inputs/employee-break-items?employeeId=${encodeURIComponent(employeeId)}`
    )
      .then((res) => {
        setItems(res.items);
        setBreakProfileName(res.breakProfile?.name ?? null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Could not load break types"));
  }, [employeeId]);

  const selectedItem = items?.find((i) => i.id === selectedValue);
  const isCustom = selectedValue === CUSTOM_VALUE;
  const reasonValid = reason.trim().length >= MIN_REASON_LENGTH;
  const canSubmit =
    Boolean(selectedValue) && Boolean(startTime) && Boolean(endTime) && reasonValid && !submitting;

  // Non-blocking preview of what this break will do to today's activities
  // (split/trim/remove one, or nothing at all) — recomputed live as the
  // admin types. Never disables Save/Add; the server still makes the real
  // decision on submit.
  const splitPreview = useMemo(() => {
    if (!startTime || !endTime) return null;
    return describeBreakSplitEffect(runs, combineDateAndTimeToUtcIso(date, startTime), combineDateAndTimeToUtcIso(date, endTime));
  }, [runs, date, startTime, endTime]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await api("/api/inputs/breaks", {
        method: "POST",
        body: JSON.stringify({
          employeeId,
          date,
          breakProfileItemId: isCustom ? null : selectedValue,
          isPaid: isCustom ? customIsPaid === "paid" : undefined,
          startTime: combineDateAndTimeToUtcIso(date, startTime),
          endTime: combineDateAndTimeToUtcIso(date, endTime),
          reason: reason.trim(),
        }),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add the break");
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Add Break" onClose={submitting ? () => {} : onClose}>
      <form onSubmit={handleSubmit} className="employee-form" noValidate>
        {loadError && <p className="error-text">{loadError}</p>}

        <div className="employee-form-grid">
          <label>
            Employee
            <input type="text" value={employeeName} disabled readOnly />
          </label>
          <label>
            Date
            <input type="text" value={formatDateLong(date)} disabled readOnly />
          </label>

          <label>
            Break type *
            <select
              value={selectedValue}
              disabled={submitting || !items}
              required
              onChange={(e) => setSelectedValue(e.target.value)}
            >
              <option value="">{items ? "Select a break type" : "Loading break types…"}</option>
              {items?.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name ?? "Break"} ({i.startTime.slice(0, 5)}–{i.endTime.slice(0, 5)}, {i.isPaid ? "Paid" : "Unpaid"})
                </option>
              ))}
              {items && (
                <option value={CUSTOM_VALUE}>
                  Custom {breakProfileName ? `(not on ${breakProfileName})` : ""}
                </option>
              )}
            </select>
            {items && items.length === 0 && (
              <span className="field-hint">
                This employee has no active assigned break profile — only Custom is available.
              </span>
            )}
          </label>

          {isCustom && (
            <label>
              Paid or unpaid *
              <select
                value={customIsPaid}
                disabled={submitting}
                onChange={(e) => setCustomIsPaid(e.target.value as "paid" | "unpaid")}
              >
                <option value="unpaid">Unpaid</option>
                <option value="paid">Paid</option>
              </select>
            </label>
          )}

          <label>
            Start time *
            <input
              type="time"
              step={1}
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              disabled={submitting}
              required
            />
          </label>

          <label>
            End time *
            <input
              type="time"
              step={1}
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              disabled={submitting}
              required
            />
          </label>

          <label>
            Reason *
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Employee forgot to start their break on their phone"
              disabled={submitting}
              required
            />
          </label>
        </div>

        {selectedItem && (
          <p className="field-hint">
            This break type is {selectedItem.isPaid ? "paid" : "unpaid"}, inherited from the employee's assigned
            break profile.
          </p>
        )}

        {splitPreview && <p className="warning-text">{splitPreview}</p>}

        {error && <p className="error-text">{error}</p>}

        <div className="employee-form-actions">
          <button type="button" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="employees-add-button" disabled={!canSubmit}>
            {submitting ? "Adding…" : "Add Break"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
