import { FormEvent, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import { Activity, ActivityQuestionDraft } from "../../lib/activityTypes";
import { QuestionsEditor, serializeQuestionDrafts, toQuestionDrafts } from "./QuestionsEditor";

interface ActivityQuestionsModalProps {
  activity: Activity;
  onClose: () => void;
  onSaved: () => void;
}

// The standalone "Activity Questions" button's editor — same ordered-list
// UI (QuestionsEditor) as the create/edit modal's own Questions section,
// just scoped to saving only the question list via PUT /:id/questions
// rather than the whole activity. One editor component, two save paths;
// see QuestionsEditor's own comment for why this isn't a second
// implementation.
export function ActivityQuestionsModal({ activity, onClose, onSaved }: ActivityQuestionsModalProps) {
  const [questions, setQuestions] = useState<ActivityQuestionDraft[]>(() => toQuestionDrafts(activity.questions));
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      await api(`/api/activities/${activity.id}/questions`, {
        method: "PUT",
        body: JSON.stringify({ questions: serializeQuestionDrafts(questions) }),
      });
      onSaved();
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : "Could not save these questions");
      setSubmitting(false);
    }
  }

  return (
    <Modal title={`Activity Questions — ${activity.name}`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="employee-form" noValidate>
        <QuestionsEditor questions={questions} onChange={setQuestions} />

        {submitError && <p className="error-text">{submitError}</p>}

        <div className="employee-form-actions">
          <button type="button" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="employee-form-save" disabled={submitting}>
            {submitting ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
