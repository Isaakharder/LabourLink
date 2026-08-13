import { uuid } from "../../lib/uuid";
import {
  ActivityQuestion,
  ActivityQuestionDraft,
  QUESTION_TYPE_DEFAULT_LABEL,
  QUESTION_TYPE_LABELS,
  QUESTION_TYPES,
  QuestionType,
} from "../../lib/activityTypes";

export function toQuestionDrafts(questions: ActivityQuestion[]): ActivityQuestionDraft[] {
  return questions.map((q) => ({ key: q.id, id: q.id, questionType: q.questionType, label: q.label, isRequired: q.isRequired }));
}

// Sort order is implicit in array position — the server infers each
// question's sort_order from where it sits in this list (see upsertQuestions
// in server/src/routes/activities.ts), so drafts never carry one themselves.
export function serializeQuestionDrafts(questions: ActivityQuestionDraft[]) {
  return questions.map((q) => ({ id: q.id, questionType: q.questionType, label: q.label, isRequired: q.isRequired }));
}

interface QuestionsEditorProps {
  questions: ActivityQuestionDraft[];
  onChange: (next: ActivityQuestionDraft[]) => void;
  error?: string | null;
}

// Shared by both entry points into activity questions — the create/edit
// modal's own "Questions" section (ActivityFormModal) and the standalone
// "Activity Questions" button's editor (ActivityQuestionsModal) — so
// there's exactly one implementation of add/reorder/remove/type-select to
// keep in sync, not two. Same controlled-list-of-drafts shape as
// BreakProfileEditor's items (patch/remove/move by a stable key, parent
// owns the array), reused here because it's already the established
// pattern in this codebase for "an ordered, admin-editable child list."
export function QuestionsEditor({ questions, onChange, error }: QuestionsEditorProps) {
  const usedTypes = questions.map((q) => q.questionType);
  // "Duplicate question types may be rejected for now" — Add is disabled
  // outright once every supported type is already in the list, rather than
  // letting the admin add a duplicate and rejecting it only on save.
  const canAdd = usedTypes.length < QUESTION_TYPES.length;

  function patch(key: string, partial: Partial<ActivityQuestionDraft>) {
    onChange(questions.map((q) => (q.key === key ? { ...q, ...partial } : q)));
  }

  function remove(key: string) {
    onChange(questions.filter((q) => q.key !== key));
  }

  function move(key: string, direction: -1 | 1) {
    const index = questions.findIndex((q) => q.key === key);
    const swapWith = index + direction;
    if (index === -1 || swapWith < 0 || swapWith >= questions.length) return;
    const next = [...questions];
    [next[index], next[swapWith]] = [next[swapWith], next[index]];
    onChange(next);
  }

  function add() {
    const nextType = QUESTION_TYPES.find((t) => !usedTypes.includes(t));
    if (!nextType) return;
    onChange([
      ...questions,
      { key: uuid(), id: null, questionType: nextType, label: QUESTION_TYPE_DEFAULT_LABEL[nextType], isRequired: true },
    ]);
  }

  // Switching a row's type re-seeds its label to the new type's default —
  // simple and predictable (an admin who wants a custom label always types
  // over it after picking the type) rather than trying to guess whether the
  // old label was ever customized.
  function changeType(key: string, newType: QuestionType) {
    patch(key, { questionType: newType, label: QUESTION_TYPE_DEFAULT_LABEL[newType] });
  }

  return (
    <section className="questions-editor">
      <div className="questions-editor-header">
        <h3>Questions</h3>
        <button type="button" onClick={add} disabled={!canAdd}>
          Add Question
        </button>
      </div>

      {error && <p className="field-error">{error}</p>}

      {questions.length === 0 ? (
        <p className="placeholder-page questions-editor-empty">
          No questions — the employee starts this activity immediately.
        </p>
      ) : (
        <ol className="questions-editor-list">
          {questions.map((q, index) => {
            const availableTypes = QUESTION_TYPES.filter((t) => t === q.questionType || !usedTypes.includes(t));
            return (
              <li key={q.key} className="questions-editor-row">
                <div className="questions-editor-row-main">
                  <span className="questions-editor-index">{index + 1}.</span>
                  <select
                    className="questions-editor-type"
                    value={q.questionType}
                    onChange={(e) => changeType(q.key, e.target.value as QuestionType)}
                  >
                    {availableTypes.map((t) => (
                      <option key={t} value={t}>
                        {QUESTION_TYPE_LABELS[t]}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    className="questions-editor-label"
                    value={q.label}
                    onChange={(e) => patch(q.key, { label: e.target.value })}
                    placeholder={QUESTION_TYPE_DEFAULT_LABEL[q.questionType]}
                  />
                </div>
                <div className="questions-editor-row-controls">
                  <label className="questions-editor-required">
                    <input
                      type="checkbox"
                      checked={q.isRequired}
                      onChange={(e) => patch(q.key, { isRequired: e.target.checked })}
                    />
                    Required
                  </label>
                  <div className="questions-editor-order">
                    <button type="button" onClick={() => move(q.key, -1)} disabled={index === 0} aria-label="Move question up">
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => move(q.key, 1)}
                      disabled={index === questions.length - 1}
                      aria-label="Move question down"
                    >
                      ↓
                    </button>
                  </div>
                  <button
                    type="button"
                    className="questions-editor-remove"
                    onClick={() => remove(q.key)}
                    aria-label="Remove question"
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
