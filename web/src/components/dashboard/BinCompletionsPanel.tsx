// Admin/Manager-only "which bins need attention" entry point for the
// Picking card's bin-completion tracking — deliberately a standalone panel
// reachable only from the Dashboard, not wired into Inputs/ActivityLogsCard
// (see server/src/routes/dashboard.ts's own comment on why: avoids touching
// GET /api/inputs/daily's already-large density/ambiguity logic).
import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import { CarrierCompletionReviewModal } from "./CarrierCompletionReviewModal";
import { GetDashboardSettingsResponse } from "../../lib/dashboardTypes";

interface PendingCarrier {
  carrierId: string;
  carrierName: string;
  pendingSegmentCount: number;
}

interface BinCompletionsPanelProps {
  onClose: () => void;
  onCompleted: () => void; // a bin was confirmed — the Dashboard's cards should refresh
}

export function BinCompletionsPanel({ onClose, onCompleted }: BinCompletionsPanelProps) {
  const [pending, setPending] = useState<PendingCarrier[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<PendingCarrier | null>(null);

  async function load() {
    setError(null);
    try {
      const settings = await api<GetDashboardSettingsResponse>("/api/dashboard/settings");
      const pickingActivityIds = settings.activities.filter((a) => a.selected && a.cardType === "picking").map((a) => a.activityId);
      if (pickingActivityIds.length === 0) {
        setPending([]);
        return;
      }
      const res = await api<{ pending: PendingCarrier[] }>(
        `/api/carrier-completions/pending?activityIds=${pickingActivityIds.join(",")}`
      );
      setPending(res.pending);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load pending bins");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (reviewing) {
    return (
      <CarrierCompletionReviewModal
        carrierId={reviewing.carrierId}
        carrierName={reviewing.carrierName}
        onClose={() => setReviewing(null)}
        onCombined={() => {
          setReviewing(null);
          load();
          onCompleted();
        }}
      />
    );
  }

  return (
    <Modal title="Bin completions" onClose={onClose}>
      <p className="field-hint">
        Bins with picking work logged that hasn't been confirmed complete yet. Confirming a bin is what lets it count
        toward an employee's "bins completed" and picking speed on the Dashboard.
      </p>

      {error && <p className="error-text">{error}</p>}

      {!pending ? (
        <p>Loading...</p>
      ) : pending.length === 0 ? (
        <p className="placeholder-page">No bins are waiting on review.</p>
      ) : (
        <ul className="dashboard-settings-activity-list">
          {pending.map((p) => (
            <li key={p.carrierId}>
              <button type="button" className="dashboard-pending-bin-row" onClick={() => setReviewing(p)}>
                <span>{p.carrierName}</span>
                <span className="employees-count">
                  {p.pendingSegmentCount} segment{p.pendingSegmentCount === 1 ? "" : "s"} pending
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
