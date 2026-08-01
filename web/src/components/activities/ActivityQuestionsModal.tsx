import { Modal } from "../ui/Modal";
import { Activity } from "../../lib/activityTypes";

interface ActivityQuestionsModalProps {
  activity: Activity;
  onClose: () => void;
}

// Placeholder only — the question schema isn't designed yet. Kept as its own
// component/route so a real question editor can replace this body later
// without touching the Activities page or list.
export function ActivityQuestionsModal({ activity, onClose }: ActivityQuestionsModalProps) {
  return (
    <Modal title={`Activity Questions — ${activity.name}`} onClose={onClose}>
      <p className="placeholder-page">
        Activity questions will be configurable here in a future update.
      </p>
      <div className="employee-form-actions">
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
