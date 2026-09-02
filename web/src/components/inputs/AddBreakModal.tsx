import { FormEvent, useEffect, useMemo, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import { formatDateLong, combineDateAndTimeToUtcIso, toTimeInputValue } from "../../lib/timezone";
import { EmployeeBreakItemOption } from "../../lib/inputsTypes";
import { BreakPreviewRun, describeBreakSplitEffect } from "../../lib/breakSplitPreview";

// Sentinel <select> value for "not one of the assigned profile's scheduled
// items" — a real break_profile_items id is always a uuid, so this can
// never collide with one.
const CUSTOM_VALUE = "__custom__";

// "12:00 PM" from a "HH:MM:SS" time-of-day string — break_profile_items'
// own configured times are always a plain wall-clock reading (no date, no
// timezone conversion needed to display them), unlike formatTimeInAppTimezone
// (timezone.ts), which formats a real UTC instant.
function formatTimeOfDay12h(hms: string): string {
  const [h, m] = hms.split(":").map(Number);
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

// "1 hour", "1 hour 30 min", "15 min" — the configured duration between two
// "HH:MM:SS" time-of-day strings on the same day.
function formatDurationLabel(startHms: string, endHms: string): string {
  const toMinutes = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  };
  const mins = toMinutes(endHms) - toMinutes(startHms);
  if (mins <= 0) return "";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0 && m > 0) return `${h} hour${h !== 1 ? "s" : ""} ${m} min`;
  if (h > 0) return `${h} hour${h !== 1 ? "s" : ""}`;
  return `${m} min`;
}

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
  // Today's already-loaded breaks — used only to mark a preset already
  // present today as "Already added" / disabled in the dropdown. The
  // server (POST /breaks) is the real authority that prevents the
  // duplicate; this is a heads-up, not a second implementation of that
  // check, so it can go stale if today's data changes underneath the
  // modal without ever letting a duplicate actually through.
  breaks: { breakProfileItemId: string | null }[];
  onClose: () => void;
  onCreated: () => void;
}

// Creates a new break using the exact same model a phone-recorded break
// uses (server/src/routes/inputs.ts's POST /breaks: entry_type = 'break',
// is_paid/break_profile_item_id set the same way mobileTime.ts's
// break/start sets them) so it flows through every existing paid/unpaid
// total and reconciliation calculation with no special-casing.
//
// A preset ("configured") break type only ever sends its id — the server
// is the sole authority on that item's start/end time-of-day and
// paid/unpaid status, resolved from break_profile_items and combined with
// the selected date in the application timezone; nothing about a preset's
// time is ever typed here or trusted from this form. Custom keeps the
// original exact-administrator-entered-time behavior, with its own
// editable fields and paid/unpaid choice.
export function AddBreakModal({ employeeId, employeeName, date, runs, breaks, onClose, onCreated }: AddBreakModalProps) {
  const [items, setItems] = useState<EmployeeBreakItemOption[] | null>(null);
  const [breakProfileName, setBreakProfileName] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedValue, setSelectedValue] = useState<string>("");
  const [customIsPaid, setCustomIsPaid] = useState<"paid" | "unpaid">("unpaid");
  const [startTime, setStartTime] = useState(() => toTimeInputValue(new Date().toISOString()));
  const [endTime, setEndTime] = useState("");
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

  const alreadyAddedItemIds = useMemo(
    () => new Set(breaks.map((b) => b.breakProfileItemId).filter((id): id is string => id !== null)),
    [breaks]
  );

  const selectedItem = items?.find((i) => i.id === selectedValue);
  const isCustom = selectedValue === CUSTOM_VALUE;
  const isDuplicate = Boolean(selectedItem && alreadyAddedItemIds.has(selectedItem.id));

  // A preset's own configured time-of-day supplies start/end automatically
  // — the manual fields are only ever shown (and only ever apply) for
  // Custom. Switching to Custom clears them instead of leaving a preset's
  // leftover values sitting in fields that now mean something different,
  // so an admin can't submit a Custom break without having actually typed
  // its time.
  useEffect(() => {
    if (selectedItem) {
      setStartTime(selectedItem.startTime);
      setEndTime(selectedItem.endTime);
    } else if (selectedValue === CUSTOM_VALUE) {
      setStartTime("");
      setEndTime("");
    }
  }, [selectedValue, selectedItem]);

  const canSubmit = Boolean(selectedValue) && Boolean(startTime) && Boolean(endTime) && !isDuplicate && !submitting;

  // Non-blocking preview of what this break will do to today's activities
  // (split/trim/remove one, or nothing at all) — recomputed live, from the
  // preset's own resolved time or Custom's typed time either way. Never
  // disables Save/Add; the server still makes the real decision on submit.
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
        body: JSON.stringify(
          isCustom
            ? {
                employeeId,
                date,
                isPaid: customIsPaid === "paid",
                startTime: combineDateAndTimeToUtcIso(date, startTime),
                endTime: combineDateAndTimeToUtcIso(date, endTime),
              }
            : // Preset — only the id is sent. The server resolves the
              // authoritative configured time and paid status itself; it
              // never trusts a client-supplied time for one.
              { employeeId, date, breakProfileItemId: selectedValue }
        ),
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
              {items?.map((i) => {
                const alreadyAdded = alreadyAddedItemIds.has(i.id);
                return (
                  <option key={i.id} value={i.id} disabled={alreadyAdded}>
                    {i.name ?? "Break"} ({formatTimeOfDay12h(i.startTime)}–{formatTimeOfDay12h(i.endTime)},{" "}
                    {i.isPaid ? "Paid" : "Unpaid"}){alreadyAdded ? " — Already added" : ""}
                  </option>
                );
              })}
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
            <>
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
            </>
          )}
        </div>

        {selectedItem && !isDuplicate && (
          <p className="field-hint">
            {formatTimeOfDay12h(selectedItem.startTime)}–{formatTimeOfDay12h(selectedItem.endTime)} ·{" "}
            {formatDurationLabel(selectedItem.startTime, selectedItem.endTime)} · {selectedItem.isPaid ? "Paid" : "Unpaid"}
          </p>
        )}
        {isDuplicate && <p className="error-text">This break has already been added for this employee today.</p>}

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
