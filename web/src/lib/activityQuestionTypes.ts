// Mobile-side question/answer shapes — server-authoritative (loaded fresh
// from GET /api/mobile/activities, never edited on the phone). Sort order
// is implicit in array position (the server already returns questions
// ordered by sort_order), so unlike the desktop admin type
// (web/src/lib/activityTypes.ts's ActivityQuestion) no sortOrder field is
// carried here — nothing on the phone ever reorders this list.
export type QuestionType = "greenhouse_row" | "carrier";

export interface ActivityQuestion {
  id: string;
  questionType: QuestionType;
  label: string;
  isRequired: boolean;
}

// One answered (or explicitly skipped) question in an in-progress question
// flow — built up client-side as the employee steps through
// activity.questions in order, then sent as a batch on the final step's
// submit. Skipping an optional question simply never adds an entry for its
// questionId (the server treats an absent answer as "not provided," see
// POST /api/mobile/time-entries/work's validation).
export type QuestionAnswer =
  | { questionId: string; questionType: "greenhouse_row"; greenhouseRowId: string }
  | { questionId: string; questionType: "carrier"; carrierId: string };
