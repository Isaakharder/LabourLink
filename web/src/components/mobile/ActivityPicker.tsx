import { useEffect } from "react";
import { ActivityQuestion } from "../../lib/activityQuestionTypes";
import { Language, t } from "../../lib/i18n";

export interface PickerActivity {
  id: string;
  name: string;
  normalSpeed: number | null;
  speedUnit: string | null;
  // Ordered — zero, one, or many. An activity with an empty list starts
  // immediately (see HomeScreen's chooseActivity); any non-empty list opens
  // the multi-question flow, even if it's only one question long.
  questions: ActivityQuestion[];
}

interface ActivityPickerProps {
  activities: PickerActivity[];
  currentActivityId: string | null;
  onSelect: (activityId: string) => void;
  onClose: () => void;
  busy: boolean;
  error: string | null;
  language: Language;
}

export function ActivityPicker({
  activities,
  currentActivityId,
  onSelect,
  onClose,
  busy,
  error,
  language,
}: ActivityPickerProps) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function handlePick(activity: PickerActivity) {
    if (busy) return;
    // Re-picking the currently active job just closes the sheet — never a
    // new time entry. Enforced here so no future caller of this component
    // can forget the rule.
    if (activity.id === currentActivityId) {
      onClose();
      return;
    }
    onSelect(activity.id);
  }

  return (
    <div className="mobile-sheet-backdrop" onClick={onClose}>
      <div
        className="mobile-sheet"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t(language, "chooseJob")}
      >
        <div className="mobile-sheet-header">
          <h2>{t(language, "chooseJob")}</h2>
          <button type="button" className="mobile-sheet-close" onClick={onClose} aria-label={t(language, "close")}>
            ×
          </button>
        </div>

        {error && <p className="error-text">{error}</p>}

        {activities.length === 0 ? (
          <p className="mobile-sheet-empty">{t(language, "noActivitiesMessage")}</p>
        ) : (
          <div className="mobile-sheet-list">
            {activities.map((a) => {
              const isCurrent = a.id === currentActivityId;
              return (
                <button
                  key={a.id}
                  type="button"
                  className={`mobile-action-button mobile-sheet-item${
                    isCurrent ? " mobile-sheet-item-current" : ""
                  }`}
                  disabled={busy}
                  onClick={() => handlePick(a)}
                >
                  <span className="mobile-sheet-item-name">
                    {a.name}
                    {isCurrent && <span className="mobile-sheet-item-badge">{t(language, "current")}</span>}
                  </span>
                  {a.normalSpeed != null && (
                    <span className="mobile-sheet-item-secondary">
                      {a.normalSpeed}
                      {a.speedUnit ? ` ${a.speedUnit}` : ""}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
