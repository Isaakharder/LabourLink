import { useCallback, useEffect, useState } from "react";
import { useDevicePairing } from "../../context/DevicePairingContext";
import { useWorkSession } from "../../context/WorkSessionContext";
import { api, ApiError } from "../../lib/api";
import { uuid } from "../../lib/uuid";
import { t } from "../../lib/i18n";
import { ActivityQuestion, QuestionAnswer } from "../../lib/activityQuestionTypes";
import { ActivityPicker, PickerActivity } from "../../components/mobile/ActivityPicker";
import { RowPickerSheet, RowPickerLand } from "../../components/mobile/RowPickerSheet";
import { CarrierPickerSheet, PickerCarrier } from "../../components/mobile/CarrierPickerSheet";
import { SwitchWarningDialog } from "../../components/mobile/SwitchWarningDialog";
import { refreshTagMappingCache } from "../../lib/nfcMappingCache";
import { checkSwitchWarning, SwitchWarning } from "../../lib/nfcSwitchWarning";
import { ActivityTimer, formatElapsed } from "../../components/mobile/ActivityTimer";
import { RecentJobsCard } from "../../components/mobile/RecentJobsCard";

type Activity = PickerActivity;

// State for an in-progress multi-question flow — built up one answer at a
// time as the employee steps through `questions` in order, then submitted
// as a single batch once the last question is answered (or skipped). Used
// only for a brand-new activity start/switch (chooseActivity); editing one
// question of an already-running activity goes through SingleQuestionEdit
// below instead, which submits a single answer directly rather than
// stepping through the whole question list again.
interface PendingQuestionFlow {
  activityId: string;
  activityName: string;
  questions: ActivityQuestion[];
  stepIndex: number;
  // Keyed by questionId so a Back navigation can look up "was this question
  // already answered" without caring about array position.
  answers: Record<string, QuestionAnswer>;
}

// A single tap-to-edit question button (see the per-question button list in
// the render below) — editing one question submits the current activity's
// full answer set with just this one question's value replaced, rather
// than stepping back through every question the way changing job details
// used to. activity/question are captured at the moment the button is
// tapped so the edit sheet doesn't need to re-derive them from `activities`
// (which could theoretically change while the sheet is open).
interface SingleQuestionEdit {
  activityId: string;
  activityName: string;
  question: ActivityQuestion;
}

export function HomeScreen() {
  const { cachedEmployee, serverReachable } = useDevicePairing();
  const {
    me,
    language,
    verified,
    busy,
    online,
    error,
    setError,
    pending,
    pendingActivityName,
    handleApiError,
    perform,
  } = useWorkSession();
  const [activities, setActivities] = useState<Activity[]>([]);
  const [activitiesLoaded, setActivitiesLoaded] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [rowLands, setRowLands] = useState<RowPickerLand[] | null>(null);
  const [carriers, setCarriers] = useState<PickerCarrier[] | null>(null);
  // The single in-progress multi-question flow, whether it's for a
  // brand-new activity start/switch or a same-activity "Change job
  // details" — see PendingQuestionFlow's own comment.
  const [questionFlow, setQuestionFlow] = useState<PendingQuestionFlow | null>(null);
  const [singleQuestionEdit, setSingleQuestionEdit] = useState<SingleQuestionEdit | null>(null);
  // A same-row/minimum-duration warning blocking a submission until the
  // employee explicitly confirms or cancels — see checkSwitchWarning and
  // submitQuestionFlow below. Rendered on top of whichever picker sheet is
  // still open underneath it (never unmounted just to show this), so
  // Cancel returns straight back to scanning/manual selection with no
  // state lost.
  const [switchWarning, setSwitchWarning] = useState<{
    warning: SwitchWarning;
    targetKind: "row" | "carrier";
    activityId: string;
    activityName: string;
    answers: Record<string, QuestionAnswer>;
  } | null>(null);

  // Same event-driven wiring as loadGreenhouseRows/loadCarriers below — the
  // phone never has its own notion of which activities exist. Re-run on
  // mount, when connectivity returns, when the tab/app comes back to the
  // foreground, and right before opening the picker so the choice offered
  // is as fresh as possible. Deliberately event-driven rather than polling
  // on a timer.
  const loadActivities = useCallback(() => {
    api<{ activities: Activity[]; activityGroups: { id: string; name: string }[] }>(
      "/api/mobile/activities"
    )
      .then((res) => {
        setActivities(res.activities);
        setActivitiesLoaded(true);
      })
      .catch((err) => {
        handleApiError(err);
      });
  }, [handleApiError]);

  // Same event-driven wiring as loadActivities — the phone never has its
  // own notion of which rows exist either.
  const loadGreenhouseRows = useCallback(() => {
    api<{ lands: RowPickerLand[] }>("/api/mobile/greenhouse-rows")
      .then((res) => setRowLands(res.lands))
      .catch((err) => {
        handleApiError(err);
      });
  }, [handleApiError]);

  // Same event-driven wiring again — the phone never has its own notion of
  // which carriers exist either.
  const loadCarriers = useCallback(() => {
    api<{ carriers: PickerCarrier[] }>("/api/mobile/carriers")
      .then((res) => setCarriers(res.carriers))
      .catch((err) => {
        handleApiError(err);
      });
  }, [handleApiError]);

  // Refreshes the offline NFC tag-mapping cache (lib/nfcMappingCache.ts) —
  // same event-driven wiring as the loaders above, but deliberately
  // fire-and-forget with no handleApiError call: a failed refresh (e.g.
  // offline) just means the picker sheets keep resolving scans against
  // whatever was cached last, not a blocking error for the employee.
  const loadTagMappings = useCallback(() => {
    refreshTagMappingCache().catch(() => {});
  }, []);

  useEffect(() => {
    loadActivities();
    loadGreenhouseRows();
    loadCarriers();
    loadTagMappings();
  }, [loadActivities, loadGreenhouseRows, loadCarriers, loadTagMappings]);

  // me/online/pairing reconnection is handled centrally by
  // WorkSessionProvider (mounted once in MobileLayout, so it survives tab
  // changes) — this screen only needs to refresh its own activities/rows/
  // carriers lists when connectivity returns or the app regains focus.
  useEffect(() => {
    function goOnline() {
      loadActivities();
    }
    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        loadActivities();
        loadGreenhouseRows();
        loadCarriers();
        loadTagMappings();
      }
    }
    window.addEventListener("online", goOnline);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("online", goOnline);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [loadActivities, loadGreenhouseRows, loadCarriers, loadTagMappings]);

  function openPicker() {
    loadActivities();
    setPickerOpen(true);
  }

  // Only ever called for a brand-new activity start/switch (chooseActivity)
  // — editing a question of the already-running activity goes through
  // openSingleQuestionEdit instead, which never steps through the other
  // questions at all.
  function startQuestionFlow(activityId: string, activityName: string, questions: ActivityQuestion[]) {
    loadGreenhouseRows();
    loadCarriers();
    loadTagMappings();
    setError(null);
    setQuestionFlow({ activityId, activityName, questions, stepIndex: 0, answers: {} });
    setPickerOpen(false);
  }

  function chooseActivity(activityId: string) {
    const activity = activities.find((a) => a.id === activityId);
    // Any configured question — required or optional — opens the
    // multi-question flow so every label and Skip/Confirm choice is always
    // shown, even for a single question. Only an activity with an empty
    // question list starts immediately.
    if (activity && activity.questions.length > 0) {
      startQuestionFlow(activity.id, activity.name, activity.questions);
      return;
    }
    // clientStartedAt: the phone's own clock reading of this exact tap,
    // captured now rather than whenever the request actually reaches the
    // server — if this goes into the offline queue (offlineQueue.ts) and
    // replays hours later, the server still rounds against the real tap
    // moment instead of the delayed sync time (see mobileTime.ts's
    // resolveOriginalStartedAt). Only meaningful to the server when this
    // turns out to be a genuine workday start, not an activity change —
    // sent unconditionally anyway since it's cheap and this same call site
    // serves both cases.
    perform(
      "/api/mobile/time-entries/work",
      { activityId, idempotencyKey: uuid(), clientStartedAt: new Date().toISOString() },
      { pendingLabel: activity?.name, onResolved: () => setPickerOpen(false) }
    );
  }

  // Submits the complete answer set collected so far as one work-start
  // request — called once the flow's last question is answered or
  // skipped, never mid-flow. answers is passed explicitly (rather than
  // read from `questionFlow` state) because the caller that just answered
  // the final question hasn't necessarily re-rendered with that answer
  // committed to state yet.
  //
  // A single-question edit's "do not start a new segment unless something
  // actually changed" requirement is enforced here, generically, rather
  // than as a special mode: if the target activity is the one already
  // running and every submitted answer matches what's already recorded on
  // it, there's nothing to change — the flow just closes with no API call
  // (no new segment, no fresh idempotencyKey, no timer reset). This can
  // only actually trigger from confirmSingleQuestionEdit/
  // skipSingleQuestionEdit; a brand-new start/switch's activityId is never
  // the currently-open one (the ActivityPicker already short-circuits
  // re-picking the current activity before any question flow opens at
  // all).
  function submitQuestionFlow(
    activityId: string,
    activityName: string,
    answers: Record<string, QuestionAnswer>,
    // Set only after the employee has explicitly dismissed the same-row or
    // minimum-duration warning below (SwitchWarningDialog's confirm
    // button) — bypasses the client-side pre-check for this one call and
    // tells the server to bypass its own identical check too (see
    // mobileTime.ts's confirmSwitch).
    confirmSwitch = false
  ) {
    const rowAnswer = Object.values(answers).find(
      (a): a is Extract<QuestionAnswer, { questionType: "greenhouse_row" }> => a.questionType === "greenhouse_row"
    );
    const carrierAnswer = Object.values(answers).find(
      (a): a is Extract<QuestionAnswer, { questionType: "carrier" }> => a.questionType === "carrier"
    );
    const newRowId = rowAnswer?.greenhouseRowId ?? null;
    const newCarrierId = carrierAnswer?.carrierId ?? null;

    if (me?.status === "work" && me.currentActivity?.id === activityId) {
      const currentRowId = me.currentActivity.row?.id ?? null;
      const currentCarrierId = me.currentActivity.carrier?.id ?? null;
      if (newRowId === currentRowId && newCarrierId === currentCarrierId) {
        setQuestionFlow(null);
        setSingleQuestionEdit(null);
        return;
      }
    }

    const targetKind: "row" | "carrier" = newCarrierId !== null ? "carrier" : "row";

    // Client-side pre-check — immediate, offline-capable UX only; the
    // server independently re-checks the identical rule (see
    // mobileTime.ts), so a stale me/recentJobs cache here can never let a
    // switch that should have warned go through silently, it just means
    // the warning shows up one round trip later instead (the onConflict
    // handler below).
    if (!confirmSwitch && me) {
      const warning = checkSwitchWarning(
        { status: me.status, currentActivity: me.currentActivity, recentJobs: me.recentJobs },
        activityId,
        newRowId,
        newCarrierId,
        new Date()
      );
      if (warning) {
        setSwitchWarning({ warning, targetKind, activityId, activityName, answers });
        return;
      }
    }

    const answersPayload = Object.values(answers).map((a) =>
      a.questionType === "greenhouse_row"
        ? { questionId: a.questionId, greenhouseRowId: a.greenhouseRowId }
        : { questionId: a.questionId, carrierId: a.carrierId }
    );
    // See chooseActivity's identical clientStartedAt comment above — same
    // reasoning, same call site shape, just reached via the question flow.
    perform(
      "/api/mobile/time-entries/work",
      {
        activityId,
        answers: answersPayload,
        idempotencyKey: uuid(),
        clientStartedAt: new Date().toISOString(),
        confirmSwitch,
      },
      {
        pendingLabel: activityName,
        onResolved: () => {
          setQuestionFlow(null);
          setSingleQuestionEdit(null);
          setSwitchWarning(null);
        },
        // The server's own authoritative check, for the case the client-
        // side pre-check above missed (stale me/recentJobs) — same dialog,
        // just arriving a round trip later instead of instantly.
        onConflict: (err: ApiError) => {
          if (err.code !== "SAME_ROW_RECENTLY_COMPLETED" && err.code !== "MINIMUM_DURATION_NOT_REACHED") return false;
          const body = (err.body ?? {}) as { elapsedSeconds?: number; minimumMinutes?: number };
          const warning: SwitchWarning =
            err.code === "SAME_ROW_RECENTLY_COMPLETED"
              ? { kind: "sameRow" }
              : {
                  kind: "minimumDuration",
                  elapsedSeconds: body.elapsedSeconds ?? 0,
                  minimumMinutes: body.minimumMinutes ?? 0,
                };
          setSwitchWarning({ warning, targetKind, activityId, activityName, answers });
          return true;
        },
      }
    );
  }

  // Records the current step's answer and either advances to the next
  // question or — on the last one — submits the whole batch. Preserving
  // prior answers across Back is automatic here: they're never removed
  // from `answers`, only ever added to or overwritten for the current
  // step's own questionId.
  function answerQuestionStep(answer: QuestionAnswer) {
    if (!questionFlow) return;
    const nextAnswers = { ...questionFlow.answers, [answer.questionId]: answer };
    const nextIndex = questionFlow.stepIndex + 1;
    if (nextIndex >= questionFlow.questions.length) {
      submitQuestionFlow(questionFlow.activityId, questionFlow.activityName, nextAnswers);
      return;
    }
    setQuestionFlow({ ...questionFlow, stepIndex: nextIndex, answers: nextAnswers });
  }

  // Only reachable when the current step's question is optional (see each
  // picker sheet's allowSkip prop) — advances without recording an answer
  // for this questionId at all (the server treats an absent answer as "not
  // provided," never as an explicit null). Explicitly *removes* any answer
  // already present for this questionId rather than just leaving it
  // untouched — this flow only ever starts from chooseActivity with an
  // empty answer set, so there's nothing to remove here in practice today,
  // but staying consistent with skipSingleQuestionEdit's same defensive
  // delete keeps both skip paths identical in shape.
  function skipQuestionStep() {
    if (!questionFlow) return;
    const currentQuestion = questionFlow.questions[questionFlow.stepIndex];
    const nextAnswers = { ...questionFlow.answers };
    delete nextAnswers[currentQuestion.id];
    const nextIndex = questionFlow.stepIndex + 1;
    if (nextIndex >= questionFlow.questions.length) {
      submitQuestionFlow(questionFlow.activityId, questionFlow.activityName, nextAnswers);
      return;
    }
    setQuestionFlow({ ...questionFlow, stepIndex: nextIndex, answers: nextAnswers });
  }

  // Goes back one question without losing that earlier question's answer
  // — `answers` is untouched, only stepIndex moves; the picker sheet for
  // that step reads its own prior answer back out of `questionFlow.answers`
  // (see the render below) to restore its selection.
  function backQuestionStep() {
    if (!questionFlow || questionFlow.stepIndex === 0) return;
    setQuestionFlow((prev) => (prev ? { ...prev, stepIndex: prev.stepIndex - 1 } : prev));
  }

  function cancelQuestionFlow() {
    if (busy) return;
    setQuestionFlow(null);
  }

  // The activity's full current answer set, derived from
  // me.currentActivity's row/carrier fields. Used to seed a single-question
  // edit's submission: editing just one question still has to submit the
  // complete answer set the server's work-start endpoint expects (it
  // validates every configured question, not just the one that changed),
  // with only the edited question's value replaced — see
  // confirmSingleQuestionEdit/skipSingleQuestionEdit below. This is the one
  // place a future question type's "what's the current value" lookup needs
  // a new case; everything else about the single-question edit flow (the
  // handlers, the button list, the sheet dispatch) is already generic over
  // `activity.questions`.
  function currentAnswersFor(activity: Activity): Record<string, QuestionAnswer> {
    const currentRowId = me?.currentActivity?.row?.id ?? null;
    const currentCarrierId = me?.currentActivity?.carrier?.id ?? null;
    const answers: Record<string, QuestionAnswer> = {};
    for (const q of activity.questions) {
      if (q.questionType === "greenhouse_row" && currentRowId) {
        answers[q.id] = { questionId: q.id, questionType: "greenhouse_row", greenhouseRowId: currentRowId };
      } else if (q.questionType === "carrier" && currentCarrierId) {
        answers[q.id] = { questionId: q.id, questionType: "carrier", carrierId: currentCarrierId };
      }
    }
    return answers;
  }

  // The generic per-question button label: what's currently answered for
  // this one question, formatted for display, or null if unanswered (an
  // optional question that was skipped) — in which case the button falls
  // back to the question's own label as a tappable prompt (see the render
  // below). Same "one place to add a case" genericity as currentAnswersFor
  // above — the button-list rendering itself never needs to change.
  function currentAnswerDisplay(question: ActivityQuestion): string | null {
    if (question.questionType === "greenhouse_row") return me?.currentActivity?.row?.label ?? null;
    if (question.questionType === "carrier") return me?.currentActivity?.carrier?.name ?? null;
    return null;
  }

  // Opens a single question's picker sheet directly — no step counter, no
  // Back, no stepping through the activity's other questions — pre-filled
  // with that one question's current answer. Replaces the old "Change job
  // details" full re-ask flow: each configured question now has its own
  // always-visible button (see the render below) and edits independently.
  function openSingleQuestionEdit(activity: Activity, question: ActivityQuestion) {
    loadGreenhouseRows();
    loadCarriers();
    loadTagMappings();
    setError(null);
    setSingleQuestionEdit({ activityId: activity.id, activityName: activity.name, question });
  }

  function cancelSingleQuestionEdit() {
    if (busy) return;
    setSingleQuestionEdit(null);
  }

  // Submits the activity's full current answer set with just this one
  // question's value replaced — reuses submitQuestionFlow's existing no-op
  // detection (if the new value matches what's already recorded, nothing
  // is submitted at all) and its "close the old segment, open a new one"
  // behavior otherwise, the same mechanics the old full re-ask flow relied
  // on, just scoped to one question instead of stepping through all of
  // them.
  // Does NOT close singleQuestionEdit itself — submitQuestionFlow's
  // onResolved does that once the request actually succeeds, and leaves it
  // open (showing the SwitchWarningDialog on top, or the sheet's own
  // `error`) if a same-row/minimum-duration warning fires or the request
  // fails. Previously this closed unconditionally before even calling
  // submitQuestionFlow, which meant a failed edit's error had nowhere left
  // to render — fixed as part of adding the warning checks, since both
  // need the same "stay open until actually resolved" behavior.
  function confirmSingleQuestionEdit(answer: QuestionAnswer) {
    if (!singleQuestionEdit) return;
    const activity = activities.find((a) => a.id === singleQuestionEdit.activityId);
    if (!activity) return;
    const answers = { ...currentAnswersFor(activity), [answer.questionId]: answer };
    submitQuestionFlow(singleQuestionEdit.activityId, singleQuestionEdit.activityName, answers);
  }

  // Only reachable when the question being edited is optional (see
  // allowSkip in the render below) — submits the current answer set with
  // this one question's answer removed entirely, same "absent, not
  // explicit null" convention skipQuestionStep already uses. Same
  // does-not-close-early note as confirmSingleQuestionEdit above.
  function skipSingleQuestionEdit() {
    if (!singleQuestionEdit) return;
    const activity = activities.find((a) => a.id === singleQuestionEdit.activityId);
    if (!activity) return;
    const answers = currentAnswersFor(activity);
    delete answers[singleQuestionEdit.question.id];
    submitQuestionFlow(singleQuestionEdit.activityId, singleQuestionEdit.activityName, answers);
  }

  // Nothing at all yet — never paired on this device before, or paired but
  // no cached employee has ever been written (shouldn't happen once paired,
  // but a first-ever pairing with no connectivity before the first /me
  // response lands here too). A real "Loading..." is the honest state.
  if (!me && !cachedEmployee) {
    return (
      <div className="mobile-home">
        <p>{t(language, "loading")}</p>
      </div>
    );
  }

  // A cached name exists from a previous session, but this session hasn't
  // reached the server yet — show who's paired and that we're reconnecting,
  // but nothing that assumes we know their actual current status (idle?
  // mid-shift? on break?), since we genuinely don't yet. No action buttons
  // at all here rather than guessing which ones would be safe.
  if (!me && cachedEmployee) {
    return (
      <div className="mobile-home">
        <div className="mobile-home-header">
          <span className="connection-dot offline" />
          <h1>
            {cachedEmployee.firstName} {cachedEmployee.lastName}
          </h1>
        </div>
        <div className="mobile-offline-banner">{t(language, "offlineReconnecting")}</div>
        <p className="mobile-cached-note">
          {t(language, "lastConfirmed", { date: new Date(cachedEmployee.lastVerifiedAt).toLocaleString() })}
        </p>
        {error && <p className="error-text">{error}</p>}
      </div>
    );
  }

  const noActivitiesAvailable = activitiesLoaded && activities.length === 0;
  const actionsLocked = !verified || busy;

  return (
    <div className="mobile-home mobile-home-active">
      {/* 1. Employee name + connection status */}
      <div className="mobile-home-header">
        <span className={`connection-dot ${online && serverReachable ? "online" : "offline"}`} />
        <h1>
          {me!.employee.firstName} {me!.employee.lastName}
        </h1>
      </div>

      {!serverReachable && <div className="mobile-offline-banner">{t(language, "offlineReconnecting")}</div>}

      {/* 2. Current state */}
      <div className="work-status">
        {me!.status === "idle" && <p>{t(language, "statusIdle")}</p>}
        {me!.status === "work" && <p>{t(language, "statusWorking")}</p>}
        {me!.status === "break" && <p>{t(language, "statusOnBreak")}</p>}
      </div>

      {error && !pickerOpen && !questionFlow && !singleQuestionEdit && <p className="error-text">{error}</p>}

      {/* 3. Primary activity button */}
      {me!.status === "idle" && (
        <button
          type="button"
          className="mobile-primary-activity"
          disabled={actionsLocked || noActivitiesAvailable}
          onClick={openPicker}
        >
          {t(language, "chooseJob")}
        </button>
      )}
      {me!.status === "work" && me!.currentActivity && (
        <button type="button" className="mobile-primary-activity" disabled={actionsLocked} onClick={openPicker}>
          {me!.currentActivity.name}
        </button>
      )}
      {/* One button per configured activity question, in order — fully
          generic over activity.questions, never hardcoded per question
          type (see currentAnswersFor/currentAnswerDisplay above for the
          one place a future question type needs its own case). Tapping a
          button edits only that question; the others are left exactly as
          they are. */}
      {me!.status === "work" &&
        me!.currentActivity &&
        (() => {
          const activity = activities.find((a) => a.id === me!.currentActivity!.id);
          if (!activity || activity.questions.length === 0) return null;
          return (
            <>
              {activity.questions.map((q) => (
                <button
                  key={q.id}
                  type="button"
                  className="mobile-question-button"
                  disabled={actionsLocked}
                  onClick={() => openSingleQuestionEdit(activity, q)}
                >
                  {currentAnswerDisplay(q) ?? q.label}
                </button>
              ))}
            </>
          );
        })()}
      {me!.status === "break" && (
        <div className="mobile-primary-activity mobile-primary-activity-static">
          {me!.previousActivity?.name ?? t(language, "statusOnBreak")}
        </div>
      )}

      {noActivitiesAvailable && me!.status === "idle" && (
        <p className="error-text">{t(language, "noActivitiesMessage")}</p>
      )}

      {/* 4. Activity timer — always directly below the last question
          button above (plain DOM order), or directly below the activity
          button itself when it has no questions. */}
      {me!.status === "work" && me!.currentActivity && (
        <ActivityTimer
          startedAt={me!.currentActivity.startedAt}
          offsetSeconds={me!.currentActivity.accumulatedWorkedSecondsBeforeCurrentEntry}
          className="mobile-timer"
        />
      )}
      {me!.status === "break" && me!.since && <ActivityTimer startedAt={me!.since} className="mobile-timer" />}
      {me!.status === "break" && me!.previousActivity && (
        <p className="mobile-timer-static">
          {t(language, "workedBeforeBreak", {
            activity: me!.previousActivity.name,
            duration: formatElapsed(me!.previousActivity.accumulatedWorkedSeconds),
          })}
        </p>
      )}

      {/* 5. Recent jobs */}
      <RecentJobsCard jobs={me!.recentJobs} language={language} />

      {/* 6. Sync/offline status */}
      <div className="connection-bar">
        <span className={`connection-dot ${online ? "online" : "offline"}`} />
        {t(language, online ? "online" : "offline")}
        {pending > 0 && <span className="pending-badge">{t(language, "pendingSync", { count: pending })}</span>}
      </div>
      {pendingActivityName && (
        <p className="mobile-pending-banner">
          {t(language, "switchingToPending", { name: pendingActivityName })}
        </p>
      )}

      {pickerOpen && (
        <ActivityPicker
          activities={activities}
          currentActivityId={me!.status === "work" ? me!.currentActivity?.id ?? null : null}
          onSelect={chooseActivity}
          onClose={() => setPickerOpen(false)}
          busy={busy}
          error={error}
          language={language}
        />
      )}

      {questionFlow &&
        (() => {
          const currentQuestion = questionFlow.questions[questionFlow.stepIndex];
          const stepLabel =
            questionFlow.questions.length > 1
              ? t(language, "stepXOfY", { step: questionFlow.stepIndex + 1, total: questionFlow.questions.length })
              : undefined;
          const priorAnswer = questionFlow.answers[currentQuestion.id];
          const onBack = questionFlow.stepIndex > 0 ? backQuestionStep : undefined;

          if (currentQuestion.questionType === "greenhouse_row") {
            const priorRowId = priorAnswer?.questionType === "greenhouse_row" ? priorAnswer.greenhouseRowId : null;
            return (
              <RowPickerSheet
                activityName={questionFlow.activityName}
                questionLabel={currentQuestion.label}
                stepLabel={stepLabel}
                allowSkip={!currentQuestion.isRequired}
                initialSelectedRowId={priorRowId}
                lands={rowLands}
                error={error}
                busy={busy}
                language={language}
                onConfirm={(rowId) =>
                  answerQuestionStep({ questionId: currentQuestion.id, questionType: "greenhouse_row", greenhouseRowId: rowId })
                }
                onNfcScan={(resolved) => {
                  // Guards against a stray/rapid repeated scan firing again
                  // while a submission is already in flight or a warning
                  // dialog is already up for a previous scan of this sheet.
                  if (busy || switchWarning) return;
                  answerQuestionStep({
                    questionId: currentQuestion.id,
                    questionType: "greenhouse_row",
                    greenhouseRowId: resolved.targetId,
                  });
                }}
                onSkip={skipQuestionStep}
                onBack={onBack}
                onCancel={cancelQuestionFlow}
              />
            );
          }

          const priorCarrierId = priorAnswer?.questionType === "carrier" ? priorAnswer.carrierId : null;
          return (
            <CarrierPickerSheet
              activityName={questionFlow.activityName}
              questionLabel={currentQuestion.label}
              stepLabel={stepLabel}
              allowSkip={!currentQuestion.isRequired}
              initialSelectedCarrierId={priorCarrierId}
              carriers={carriers}
              error={error}
              busy={busy}
              language={language}
              onConfirm={(carrierId) =>
                answerQuestionStep({ questionId: currentQuestion.id, questionType: "carrier", carrierId })
              }
              onNfcScan={(resolved) => {
                if (busy || switchWarning) return;
                answerQuestionStep({ questionId: currentQuestion.id, questionType: "carrier", carrierId: resolved.targetId });
              }}
              onSkip={skipQuestionStep}
              onBack={onBack}
              onCancel={cancelQuestionFlow}
            />
          );
        })()}

      {switchWarning && (
        <SwitchWarningDialog
          warning={switchWarning.warning}
          targetKind={switchWarning.targetKind}
          submitting={busy}
          language={language}
          onConfirm={() => {
            const pending = switchWarning;
            submitQuestionFlow(pending.activityId, pending.activityName, pending.answers, true);
          }}
          onCancel={() => setSwitchWarning(null)}
        />
      )}

      {/* Single-question edit sheet — opened by tapping one of the
          per-question buttons above. Same per-type dispatch as the
          multi-question flow above (each question type still needs its own
          picker sheet component), but no stepLabel/onBack: this always
          edits exactly one question, pre-filled with its current answer. */}
      {singleQuestionEdit &&
        (() => {
          const q = singleQuestionEdit.question;
          if (q.questionType === "greenhouse_row") {
            return (
              <RowPickerSheet
                activityName={singleQuestionEdit.activityName}
                questionLabel={q.label}
                allowSkip={!q.isRequired}
                initialSelectedRowId={me!.currentActivity?.row?.id ?? null}
                lands={rowLands}
                error={error}
                busy={busy}
                language={language}
                onConfirm={(rowId) =>
                  confirmSingleQuestionEdit({ questionId: q.id, questionType: "greenhouse_row", greenhouseRowId: rowId })
                }
                onNfcScan={(resolved) => {
                  if (busy || switchWarning) return;
                  confirmSingleQuestionEdit({ questionId: q.id, questionType: "greenhouse_row", greenhouseRowId: resolved.targetId });
                }}
                onSkip={skipSingleQuestionEdit}
                onCancel={cancelSingleQuestionEdit}
              />
            );
          }

          return (
            <CarrierPickerSheet
              activityName={singleQuestionEdit.activityName}
              questionLabel={q.label}
              allowSkip={!q.isRequired}
              initialSelectedCarrierId={me!.currentActivity?.carrier?.id ?? null}
              carriers={carriers}
              error={error}
              busy={busy}
              language={language}
              onConfirm={(carrierId) => confirmSingleQuestionEdit({ questionId: q.id, questionType: "carrier", carrierId })}
              onNfcScan={(resolved) => {
                if (busy || switchWarning) return;
                confirmSingleQuestionEdit({ questionId: q.id, questionType: "carrier", carrierId: resolved.targetId });
              }}
              onSkip={skipSingleQuestionEdit}
              onCancel={cancelSingleQuestionEdit}
            />
          );
        })()}
    </div>
  );
}
