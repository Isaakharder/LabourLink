import { useCallback, useEffect, useState } from "react";
import { useDevicePairing } from "../../context/DevicePairingContext";
import { api, ApiError, isPermanentDeviceAuthError, isServerUnreachableError } from "../../lib/api";
import { enqueue, flushQueue, getPendingCount, isNetworkError } from "../../lib/offlineQueue";
import { uuid } from "../../lib/uuid";
import { ActivityQuestion, QuestionAnswer } from "../../lib/activityQuestionTypes";
import { ActivityPicker, NO_ACTIVITIES_MESSAGE, PickerActivity } from "../../components/mobile/ActivityPicker";
import { RowPickerSheet, RowPickerLand } from "../../components/mobile/RowPickerSheet";
import { CarrierPickerSheet, PickerCarrier } from "../../components/mobile/CarrierPickerSheet";
import { ActivityTimer, formatElapsed } from "../../components/mobile/ActivityTimer";
import { RecentJobsCard, RecentJob } from "../../components/mobile/RecentJobsCard";
import { ConfirmEndDayModal } from "../../components/mobile/ConfirmEndDayModal";

type Activity = PickerActivity;

interface CurrentActivity {
  id: string;
  name: string;
  startedAt: string;
  // Seconds accumulated across earlier segments of the same continuous job
  // chain (same activity, separated only by breaks) before this entry —
  // the live elapsed time since startedAt is added on top by ActivityTimer.
  accumulatedWorkedSecondsBeforeCurrentEntry: number;
  row: { id: string; label: string } | null;
  carrier: { id: string; name: string } | null;
}

// State for an in-progress multi-question flow — built up one answer at a
// time as the employee steps through `questions` in order, then submitted
// as a single batch once the last question is answered (or skipped). Used
// both for a brand-new activity start/switch and for "Change job details"
// (same activity, re-answering to open a new segment) — the two differ
// only in what activityId/activityName/questions get passed in, never in
// how the flow itself advances.
interface PendingQuestionFlow {
  activityId: string;
  activityName: string;
  questions: ActivityQuestion[];
  stepIndex: number;
  // Keyed by questionId so a Back navigation can look up "was this question
  // already answered" without caring about array position.
  answers: Record<string, QuestionAnswer>;
}

interface PreviousActivity {
  id: string;
  name: string;
  // Running total for the whole chain up through the segment that just
  // closed when this break started — not just that one segment's length.
  accumulatedWorkedSeconds: number;
}

interface MeResponse {
  employee: { id: string; firstName: string; lastName: string };
  status: "idle" | "work" | "break";
  currentActivity: CurrentActivity | null;
  since: string | null;
  previousActivity: PreviousActivity | null;
  recentJobs: RecentJob[];
}

// While the server hasn't yet been reached this poll cycle, retry this
// often — only runs while serverReachable is false (see the effect below),
// so a healthy app never has a background timer running at all.
const RECONNECT_POLL_INTERVAL_MS = 15000;

export function HomeScreen() {
  const { markUnpaired, cachedEmployee, serverReachable, setServerReachable, refreshCachedEmployee } =
    useDevicePairing();
  const [me, setMe] = useState<MeResponse | null>(null);
  // True once a real /api/mobile/me response has been received this
  // session — gates every server-dependent action button. Before that (the
  // "just launched, still offline" window), the last-known employee name is
  // shown from the pairing context's cache, but nothing that assumes we
  // know the employee's true current status is offered, since we don't
  // actually know it yet.
  const [verified, setVerified] = useState(false);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [activitiesLoaded, setActivitiesLoaded] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [rowLands, setRowLands] = useState<RowPickerLand[] | null>(null);
  const [carriers, setCarriers] = useState<PickerCarrier[] | null>(null);
  // The single in-progress multi-question flow, whether it's for a
  // brand-new activity start/switch or a same-activity "Change job
  // details" — see PendingQuestionFlow's own comment.
  const [questionFlow, setQuestionFlow] = useState<PendingQuestionFlow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState(getPendingCount());
  const [pendingActivityName, setPendingActivityName] = useState<string | null>(null);
  const [endDayConfirmOpen, setEndDayConfirmOpen] = useState(false);
  const [endDaySubmitting, setEndDaySubmitting] = useState(false);
  const [endDayError, setEndDayError] = useState<string | null>(null);
  const [endDayIdempotencyKey, setEndDayIdempotencyKey] = useState<string | null>(null);

  // The one place every mobile screen decides what a caught error actually
  // means: a confirmed permanent device-auth code clears pairing; a network
  // failure or 5xx means the server just wasn't reached (never touches
  // pairing, never overwrites `me`/the cached employee); anything else is a
  // real, specific rejection the caller should surface. Returns true when
  // the error was fully handled (pairing cleared or marked unreachable) so
  // callers know not to also show a generic error for it.
  const handleApiError = useCallback(
    (err: unknown): boolean => {
      if (isPermanentDeviceAuthError(err)) {
        markUnpaired();
        return true;
      }
      if (isServerUnreachableError(err)) {
        setServerReachable(false);
        return true;
      }
      setServerReachable(true); // a real response came back — the server is up
      return false;
    },
    [markUnpaired, setServerReachable]
  );

  const loadMe = useCallback(() => {
    api<MeResponse>("/api/mobile/me")
      .then((res) => {
        setMe(res);
        setVerified(true);
        setServerReachable(true);
        refreshCachedEmployee({
          employeeId: res.employee.id,
          firstName: res.employee.firstName,
          lastName: res.employee.lastName,
          lastVerifiedAt: new Date().toISOString(),
        });
      })
      .catch((err) => {
        if (!handleApiError(err)) setError("Could not load status");
      });
  }, [handleApiError, refreshCachedEmployee, setServerReachable]);

  // Same event-driven wiring as loadActivities — the phone never has its
  // own notion of which activities exist. Re-run on mount, when connectivity
  // returns, when the tab/app comes back to the foreground, and right
  // before opening the picker so the choice offered is as fresh as
  // possible. Deliberately event-driven rather than polling on a timer.
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

  useEffect(() => {
    loadMe();
    loadActivities();
    loadGreenhouseRows();
    loadCarriers();
  }, [loadMe, loadActivities, loadGreenhouseRows, loadCarriers]);

  // Runs only while the server hasn't been reached — an app left open on
  // screen through a server restart/deploy must reconnect on its own, not
  // only when the tab happens to regain focus or the browser's own
  // online/offline events happen to fire (neither necessarily happens for
  // "Wi-Fi was fine the whole time, the API process itself was down").
  // Stops itself the moment loadMe succeeds and serverReachable flips back.
  useEffect(() => {
    if (serverReachable) return;
    const interval = window.setInterval(loadMe, RECONNECT_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [serverReachable, loadMe]);

  const flush = useCallback(() => {
    // flushQueue's own retry/drop logic only knows "network error" (keep
    // queued) vs "anything else" (drop, report as rejected) — it has no
    // notion of device-auth codes. A queued action replayed after the
    // device was deactivated/unassigned while offline would otherwise just
    // get silently dropped and reported as an ordinary "activity no longer
    // available" rejection, never actually returning the app to Pairing.
    // This flag, set from inside the send wrapper, is how that specific
    // case still gets caught once the whole queue has drained.
    let permanentFailure = false;
    flushQueue((path, body) =>
      api(path, { method: "POST", body: JSON.stringify(body) }).catch((err) => {
        if (isPermanentDeviceAuthError(err)) permanentFailure = true;
        throw err;
      })
    )
      .then(({ rejected }) => {
        setPending(getPendingCount());
        if (permanentFailure) {
          markUnpaired();
          return;
        }
        if (rejected.length > 0) {
          setError(
            "One or more queued activity changes could not be completed because the activity is no longer available. Your status has been refreshed — please choose again."
          );
        }
        if (getPendingCount() === 0) {
          setPendingActivityName(null);
        }
        loadMe();
        loadActivities();
      })
      .catch(() => {});
  }, [loadMe, loadActivities, markUnpaired]);

  useEffect(() => {
    function goOnline() {
      setOnline(true);
      flush();
    }
    function goOffline() {
      setOnline(false);
    }
    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        loadMe();
        loadActivities();
        loadGreenhouseRows();
        loadCarriers();
      }
    }
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    document.addEventListener("visibilitychange", onVisibilityChange);
    if (navigator.onLine) flush();
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [flush, loadMe, loadActivities, loadGreenhouseRows, loadCarriers]);

  async function perform(path: string, body: Record<string, unknown>, pendingLabel?: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await api<MeResponse>(path, { method: "POST", body: JSON.stringify(body) });
      setMe(result);
      setVerified(true);
      setServerReachable(true);
      refreshCachedEmployee({
        employeeId: result.employee.id,
        firstName: result.employee.firstName,
        lastName: result.employee.lastName,
        lastVerifiedAt: new Date().toISOString(),
      });
      setPendingActivityName(null);
      setPickerOpen(false);
      setQuestionFlow(null);
    } catch (err) {
      if (isPermanentDeviceAuthError(err)) {
        markUnpaired();
        return;
      }
      if (isNetworkError(err)) {
        enqueue({ id: body.idempotencyKey as string, path, body });
        setPending(getPendingCount());
        setServerReachable(false);
        // Visible-but-honest: no timer starts locally for this — it only
        // starts once a real server startedAt comes back after a
        // successful flush. This just tells the employee what's queued.
        if (pendingLabel) setPendingActivityName(pendingLabel);
        setPickerOpen(false);
        setQuestionFlow(null);
      } else if (err instanceof ApiError && err.status >= 500) {
        setServerReachable(false);
      } else {
        // Stays open (whichever sheet — ActivityPicker, RowPickerSheet, or
        // CarrierPickerSheet — triggered this) so the employee sees the
        // error and can retry without losing their place; every sheet
        // renders `error` inline.
        setServerReachable(true);
        setError(err instanceof ApiError ? err.message : "Something went wrong");
      }
    } finally {
      setBusy(false);
    }
  }

  function openPicker() {
    loadActivities();
    setPickerOpen(true);
  }

  // Shared by a brand-new activity start/switch (chooseActivity) and
  // same-activity "Change job details" (openChangeJobDetails) — both just
  // need to know which activity, which ordered questions to ask, and what
  // (if anything) each question should start out already answered with;
  // everything about *advancing* through them is identical either way.
  // initialAnswers defaults to empty for a brand-new start/switch — Change
  // job details is the only caller that ever passes a non-empty one.
  function startQuestionFlow(
    activityId: string,
    activityName: string,
    questions: ActivityQuestion[],
    initialAnswers: Record<string, QuestionAnswer> = {}
  ) {
    loadGreenhouseRows();
    loadCarriers();
    setError(null);
    setQuestionFlow({ activityId, activityName, questions, stepIndex: 0, answers: initialAnswers });
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
    perform("/api/mobile/time-entries/work", { activityId, idempotencyKey: uuid() }, activity?.name);
  }

  // Submits the complete answer set collected so far as one work-start
  // request — called once the flow's last question is answered or
  // skipped, never mid-flow. answers is passed explicitly (rather than
  // read from `questionFlow` state) because the caller that just answered
  // the final question hasn't necessarily re-rendered with that answer
  // committed to state yet.
  //
  // Change job details' "do not start a new segment unless something
  // actually changed" requirement is enforced here, generically, rather
  // than as a special mode: if the target activity is the one already
  // running and every submitted answer matches what's already recorded on
  // it, there's nothing to change — the flow just closes with no API call
  // (no new segment, no fresh idempotencyKey, no timer reset). This can
  // only actually trigger for Change job details; a brand-new
  // start/switch's activityId is never the currently-open one (the
  // ActivityPicker already short-circuits re-picking the current activity
  // before any question flow opens at all).
  function submitQuestionFlow(
    activityId: string,
    activityName: string,
    answers: Record<string, QuestionAnswer>
  ) {
    if (me?.status === "work" && me.currentActivity?.id === activityId) {
      const rowAnswer = Object.values(answers).find(
        (a): a is Extract<QuestionAnswer, { questionType: "greenhouse_row" }> => a.questionType === "greenhouse_row"
      );
      const carrierAnswer = Object.values(answers).find(
        (a): a is Extract<QuestionAnswer, { questionType: "carrier" }> => a.questionType === "carrier"
      );
      const newRowId = rowAnswer?.greenhouseRowId ?? null;
      const newCarrierId = carrierAnswer?.carrierId ?? null;
      const currentRowId = me.currentActivity.row?.id ?? null;
      const currentCarrierId = me.currentActivity.carrier?.id ?? null;
      if (newRowId === currentRowId && newCarrierId === currentCarrierId) {
        setQuestionFlow(null);
        return;
      }
    }

    const answersPayload = Object.values(answers).map((a) =>
      a.questionType === "greenhouse_row"
        ? { questionId: a.questionId, greenhouseRowId: a.greenhouseRowId }
        : { questionId: a.questionId, carrierId: a.carrierId }
    );
    perform(
      "/api/mobile/time-entries/work",
      { activityId, answers: answersPayload, idempotencyKey: uuid() },
      activityName
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
  // untouched — Change job details can open this step pre-filled from the
  // current segment, and skipping it must mean "no carrier," not "silently
  // keep submitting the old one."
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

  // "Change job details" — the only UI path for requirement 10's "same
  // activity, different row or carrier." Re-runs the full question
  // sequence, pre-filled with whatever the current segment is already
  // answered with (each picker sheet reads its own question's entry out of
  // questionFlow.answers as `initialSelectedRowId`/`initialSelectedCarrierId`
  // — see the render below), so the employee can keep an answer with a
  // plain Confirm, change just one, or Skip an optional one back to "none."
  // Submitting reuses the exact same perform() call the initial
  // required-question start does, just with the current activity's id; a
  // fresh idempotencyKey is what makes the server open a new row/carrier
  // segment and close the old one (see openEntry in mobileTime.ts), and
  // accumulateChainSeconds' row/carrier-equality check is what makes the
  // timer correctly reset for it — but only when something actually
  // changed, see submitQuestionFlow's own no-op check.
  function openChangeJobDetails() {
    if (!me?.currentActivity) return;
    const activity = activities.find((a) => a.id === me.currentActivity!.id);
    if (!activity || activity.questions.length === 0) return;

    const currentRowId = me.currentActivity.row?.id ?? null;
    const currentCarrierId = me.currentActivity.carrier?.id ?? null;
    const initialAnswers: Record<string, QuestionAnswer> = {};
    for (const q of activity.questions) {
      if (q.questionType === "greenhouse_row" && currentRowId) {
        initialAnswers[q.id] = { questionId: q.id, questionType: "greenhouse_row", greenhouseRowId: currentRowId };
      } else if (q.questionType === "carrier" && currentCarrierId) {
        initialAnswers[q.id] = { questionId: q.id, questionType: "carrier", carrierId: currentCarrierId };
      }
    }

    startQuestionFlow(activity.id, activity.name, activity.questions, initialAnswers);
  }

  function startBreak() {
    perform("/api/mobile/time-entries/break/start", { idempotencyKey: uuid() });
  }

  function endBreak() {
    perform("/api/mobile/time-entries/break/end", { idempotencyKey: uuid() });
  }

  function openEndDayConfirm() {
    setEndDayError(null);
    setEndDayIdempotencyKey(uuid());
    setEndDayConfirmOpen(true);
  }

  function closeEndDayConfirm() {
    if (endDaySubmitting) return; // block dismissal while a request is in flight
    setEndDayConfirmOpen(false);
    setEndDayError(null);
  }

  // Deliberately bypasses perform(): ending the day must never be silently
  // queued for later (per requirement — it's the one action that should
  // require a live connection), whereas perform()'s network-error branch
  // exists specifically to queue everything else for offline replay.
  async function confirmEndDay() {
    if (!online) {
      setEndDayError("You must be online to finish work.");
      return;
    }
    if (!endDayIdempotencyKey) return;

    setEndDaySubmitting(true);
    setEndDayError(null);
    try {
      const result = await api<MeResponse>("/api/mobile/time-entries/end-day", {
        method: "POST",
        body: JSON.stringify({ idempotencyKey: endDayIdempotencyKey }),
      });
      setMe(result);
      setVerified(true);
      setServerReachable(true);
      setEndDayConfirmOpen(false);
    } catch (err) {
      if (isPermanentDeviceAuthError(err)) {
        markUnpaired();
        return;
      }
      // Stay open, reusing the same idempotency key on retry — if the
      // first attempt actually succeeded server-side but the response was
      // lost, a retry with the same key returns that same result instead
      // of ending the day twice.
      if (isServerUnreachableError(err)) {
        setServerReachable(false);
        setEndDayError("Could not reach the server. Please try again.");
      } else {
        setEndDayError(err instanceof ApiError ? err.message : "Could not finish work. Please try again.");
      }
    } finally {
      setEndDaySubmitting(false);
    }
  }

  // Nothing at all yet — never paired on this device before, or paired but
  // no cached employee has ever been written (shouldn't happen once paired,
  // but a first-ever pairing with no connectivity before the first /me
  // response lands here too). A real "Loading..." is the honest state.
  if (!me && !cachedEmployee) {
    return (
      <div className="mobile-home">
        <p>Loading...</p>
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
        <div className="mobile-offline-banner">Offline — reconnecting…</div>
        <p className="mobile-cached-note">
          Last confirmed {new Date(cachedEmployee.lastVerifiedAt).toLocaleString()}
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

      {!serverReachable && <div className="mobile-offline-banner">Offline — reconnecting…</div>}

      {/* 2. Current state */}
      <div className="work-status">
        {me!.status === "idle" && <p>Not working</p>}
        {me!.status === "work" && <p>Working</p>}
        {me!.status === "break" && <p>On break</p>}
      </div>

      {error && !pickerOpen && !questionFlow && !endDayConfirmOpen && <p className="error-text">{error}</p>}

      {/* 3. Primary activity button */}
      {me!.status === "idle" && (
        <button
          type="button"
          className="mobile-primary-activity"
          disabled={actionsLocked || noActivitiesAvailable}
          onClick={openPicker}
        >
          Choose a job
        </button>
      )}
      {me!.status === "work" && me!.currentActivity && (
        <button type="button" className="mobile-primary-activity" disabled={actionsLocked} onClick={openPicker}>
          {me!.currentActivity.name}
        </button>
      )}
      {me!.status === "work" && (me!.currentActivity?.row || me!.currentActivity?.carrier) && (
        <button type="button" className="mobile-change-row" disabled={actionsLocked} onClick={openChangeJobDetails}>
          {[me!.currentActivity?.row?.label, me!.currentActivity?.carrier?.name].filter(Boolean).join(" · ")} · Change
        </button>
      )}
      {me!.status === "break" && (
        <div className="mobile-primary-activity mobile-primary-activity-static">
          {me!.previousActivity?.name ?? "On break"}
        </div>
      )}

      {noActivitiesAvailable && me!.status === "idle" && <p className="error-text">{NO_ACTIVITIES_MESSAGE}</p>}

      {/* 4. Activity timer */}
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
          Worked on {me!.previousActivity.name} for {formatElapsed(me!.previousActivity.accumulatedWorkedSeconds)}{" "}
          before this break
        </p>
      )}

      {/* 5. Break button */}
      {me!.status === "work" && (
        <button className="mobile-action-button" disabled={actionsLocked} onClick={startBreak}>
          Start Break
        </button>
      )}
      {me!.status === "break" && (
        <button className="mobile-action-button mobile-action-primary" disabled={actionsLocked} onClick={endBreak}>
          End Break
        </button>
      )}

      {/* 6. End Day */}
      {me!.status !== "idle" && (
        <button className="mobile-action-button mobile-action-danger" disabled={actionsLocked} onClick={openEndDayConfirm}>
          End Day
        </button>
      )}

      {/* 7. Recent jobs */}
      <RecentJobsCard jobs={me!.recentJobs} />

      {/* 8. Sync/offline status */}
      <div className="connection-bar">
        <span className={`connection-dot ${online ? "online" : "offline"}`} />
        {online ? "Online" : "Offline"}
        {pending > 0 && <span className="pending-badge">{pending} pending sync</span>}
      </div>
      {pendingActivityName && (
        <p className="mobile-pending-banner">Switching to {pendingActivityName} — will sync when back online</p>
      )}

      {pickerOpen && (
        <ActivityPicker
          activities={activities}
          currentActivityId={me!.status === "work" ? me!.currentActivity?.id ?? null : null}
          onSelect={chooseActivity}
          onClose={() => setPickerOpen(false)}
          busy={busy}
          error={error}
        />
      )}

      {questionFlow &&
        (() => {
          const currentQuestion = questionFlow.questions[questionFlow.stepIndex];
          const stepLabel =
            questionFlow.questions.length > 1
              ? `Step ${questionFlow.stepIndex + 1} of ${questionFlow.questions.length}`
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
                onConfirm={(rowId) =>
                  answerQuestionStep({ questionId: currentQuestion.id, questionType: "greenhouse_row", greenhouseRowId: rowId })
                }
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
              onConfirm={(carrierId) =>
                answerQuestionStep({ questionId: currentQuestion.id, questionType: "carrier", carrierId })
              }
              onSkip={skipQuestionStep}
              onBack={onBack}
              onCancel={cancelQuestionFlow}
            />
          );
        })()}

      {endDayConfirmOpen && (
        <ConfirmEndDayModal
          submitting={endDaySubmitting}
          error={endDayError}
          onConfirm={confirmEndDay}
          onCancel={closeEndDayConfirm}
        />
      )}
    </div>
  );
}
