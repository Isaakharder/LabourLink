import { useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api";
import { CarrierHistoryEntry } from "../../lib/carrierTypes";
import { formatDateLongInAppTimezone, formatTimeInAppTimezone } from "../../lib/timezone";

// Every change to this bin's RFID tag or tare: registrations at the weighing
// station and edits on this page (carrier_registration_audit, newest first).
export function CarrierHistory({ carrierId }: { carrierId: string }) {
  const [entries, setEntries] = useState<CarrierHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ history: CarrierHistoryEntry[] }>(`/api/carriers/${carrierId}/history`)
      .then((r) => !cancelled && setEntries(r.history))
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : "Could not load the history"));
    return () => {
      cancelled = true;
    };
  }, [carrierId]);

  return (
    <section className="employee-form-section carrier-history">
      <h3>Tag and tare history</h3>
      {error && <p className="error-text">{error}</p>}
      {!error && entries === null && <p className="field-hint">Loading…</p>}
      {entries?.length === 0 && <p className="field-hint">No tag or tare changes recorded yet.</p>}
      {entries && entries.length > 0 && (
        <ul className="carrier-history-list">
          {entries.map((e) => (
            <li key={e.id}>
              <div className="carrier-history-what">{describe(e)}</div>
              <div className="carrier-history-who field-hint">
                {formatDateLongInAppTimezone(e.performedAt)} {formatTimeInAppTimezone(e.performedAt, { seconds: false })} · {e.performedBy}
                {e.stationName ? ` at ${e.stationName}` : " on the Carriers page"}
                {e.reason ? ` · ${e.reason}` : ""}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function kg(v: number | null): string {
  return v === null ? "—" : `${v.toFixed(2)} kg`;
}

function tag(v: string | null): string {
  return v ?? "none";
}

function changes(e: CarrierHistoryEntry): string {
  const parts: string[] = [];
  if (e.oldRfidTag !== e.newRfidTag) parts.push(`tag ${tag(e.oldRfidTag)} → ${tag(e.newRfidTag)}`);
  if (e.oldTareWeightKg !== e.newTareWeightKg) parts.push(`tare ${kg(e.oldTareWeightKg)} → ${kg(e.newTareWeightKg)}`);
  return parts.length ? parts.join(", ") : "tag and tare unchanged";
}

function describe(e: CarrierHistoryEntry): string {
  switch (e.action) {
    case "register":
      return `Registered at the scale: ${changes(e)}${e.overwriteConfirmed ? " (replacement confirmed)" : ""}${
        e.movedFromName ? `, tag moved from ${e.movedFromName}` : ""
      }`;
    case "move_tag":
      return `Tag moved to ${e.movedToName ?? "another bin"}: ${changes(e)}`;
    case "remove_tag":
      return `Tag removed at the scale: ${changes(e)}`;
    case "page_create":
      return `Created: tag ${tag(e.newRfidTag)}, tare ${kg(e.newTareWeightKg)}`;
    default:
      return `Edited: ${changes(e)}`;
  }
}
