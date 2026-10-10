import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "../ui/Modal";
import { api, ApiError } from "../../lib/api";
import { formatSpeedValue } from "../../lib/reportTypes";
import { formatDateLong, formatDurationHMS, formatTimeInAppTimezone } from "../../lib/timezone";
import {
  BulkReviewResponse,
  BulkReviewResult,
  SpeedPreview,
  SpeedReviewChoice,
  SpeedReviewGroup,
  SpeedReviewGroupsResponse,
  SpeedReviewVisit,
  DEFAULT_ROW_REVIEW_WINDOW_DAYS,
} from "../../lib/speedReviewTypes";

// Bulk speed review for Inputs: every "Needs review" visit for one date —
// one employee ("Review speeds") or everyone ("Review all employees") —
// shown as compact review cards. The server builds the groups from the same
// row-cycle rules as the individual review modal and decides which actions
// each group supports (see server/src/lib/speedReviewGroups.ts); this
// component only lets an admin choose, and saves nothing until Apply.
//
// Selection decides WHAT is applied; each card's action decides HOW. A
// card's action starts at the server's suggestion, the bulk control sets it
// for every selected card that supports it, and any card can be changed
// afterwards. Unselected cards, and selected cards set to Skip, stay
// pending.

interface SpeedReviewModalProps {
  date: string;
  // null = every employee on `date`.
  employeeId: string | null;
  employeeName?: string;
  // Only Administrators can save completions (POST /api/row-completions is
  // Administrator-only); a Manager can still open and read the review.
  canApply: boolean;
  onClose: () => void;
  // Called after Apply saved at least one group, so the page can refresh
  // speeds, badges and totals through its normal reload flow.
  onApplied: () => void;
}

type BulkChoice = SpeedReviewChoice | "suggested";

// A bulk apply is one transaction over every selected group; give it far
// more room than api()'s 15s default before giving up on the answer.
const BULK_APPLY_TIMEOUT_MS = 120_000;

const ACTION_LABEL: Record<SpeedReviewChoice, string> = {
  merge: "Merge for speed",
  separate: "Keep separate",
  skip: "Skip / leave pending",
};

function isEligible(g: SpeedReviewGroup): boolean {
  return g.actions.merge.available || g.actions.separate.available;
}

function isSupported(g: SpeedReviewGroup, choice: SpeedReviewChoice): boolean {
  return choice === "skip" || g.actions[choice].available;
}

function timeRange(v: SpeedReviewVisit): string {
  return `${formatTimeInAppTimezone(v.startedAt)} – ${v.endedAt ? formatTimeInAppTimezone(v.endedAt) : "in progress"}`;
}

// "Oct 5" — the card's compact date list.
function shortDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function previewText(p: SpeedPreview, unit: string): string {
  const qtyUnit = unit.replace("/hour", "");
  const speed = p.speedPerHour != null ? formatSpeedValue(p.speedPerHour, unit) : "—";
  return `${p.quantity} ${qtyUnit} ÷ ${formatDurationHMS(p.durationSeconds)} work = ${speed}`;
}

export function SpeedReviewModal({ date, employeeId, employeeName, canApply, onClose, onApplied }: SpeedReviewModalProps) {
  const [groups, setGroups] = useState<SpeedReviewGroup[] | null>(null);
  // The Row review window these groups were cut at (Setup > Row Review).
  const [windowDays, setWindowDays] = useState(DEFAULT_ROW_REVIEW_WINDOW_DAYS);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [choices, setChoices] = useState<Record<string, SpeedReviewChoice>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [bulkChoice, setBulkChoice] = useState<BulkChoice>("suggested");
  const [bulkNote, setBulkNote] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [results, setResults] = useState<Map<string, BulkReviewResult> | null>(null);
  // Per-group reasons from a refused apply (nothing saved): shown on the
  // cards while the selections stay editable for another try.
  const [groupErrors, setGroupErrors] = useState<Map<string, string>>(new Map());
  const submittingRef = useRef(false);
  const [loadSeq, setLoadSeq] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setGroups(null);
    setLoadError(null);
    const params = new URLSearchParams({ date });
    if (employeeId) params.set("employeeId", employeeId);
    api<SpeedReviewGroupsResponse>(`/api/row-completions/review-groups?${params.toString()}`)
      .then((res) => {
        if (cancelled) return;
        setGroups(res.groups);
        setWindowDays(res.windowDays ?? DEFAULT_ROW_REVIEW_WINDOW_DAYS);
        setChoices(Object.fromEntries(res.groups.map((g) => [g.id, g.suggestedAction ?? "skip"])));
        setSelected(new Set());
        setResults(null);
        setGroupErrors(new Map());
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof ApiError ? err.message : "Could not load the speed review");
      });
    return () => {
      cancelled = true;
    };
  }, [date, employeeId, loadSeq]);

  const applied = results !== null;
  const locked = !canApply || submitting || applied;

  const byEmployee = useMemo(() => {
    const map = new Map<string, { name: string; groups: SpeedReviewGroup[] }>();
    for (const g of groups ?? []) {
      const entry = map.get(g.employeeId) ?? { name: g.employeeName, groups: [] };
      entry.groups.push(g);
      map.set(g.employeeId, entry);
    }
    return [...map.entries()];
  }, [groups]);

  const toApply = (groups ?? []).filter((g) => selected.has(g.id) && choices[g.id] !== "skip" && isSupported(g, choices[g.id]));
  const affectedEmployees = new Set(toApply.map((g) => g.employeeId)).size;
  const pendingAfter = (groups?.length ?? 0) - toApply.length;
  // What Apply will do, per action — each selected card keeps its own.
  const toMerge = toApply.filter((g) => choices[g.id] === "merge").length;
  const toSeparate = toApply.filter((g) => choices[g.id] === "separate").length;
  const groupsLabel = (n: number) => `${n} group${n === 1 ? "" : "s"}`;
  const eligibleIds = (groups ?? []).filter(isEligible).map((g) => g.id);

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function applyBulkChoice() {
    if (!groups) return;
    // Computed here, not inside a state updater: the updater runs later,
    // so a count taken inside it would still be 0 when the note is set.
    let unsupported = 0;
    const next = { ...choices };
    for (const g of groups) {
      if (!selected.has(g.id)) continue;
      const target: SpeedReviewChoice = bulkChoice === "suggested" ? g.suggestedAction ?? "skip" : bulkChoice;
      if (isSupported(g, target)) next[g.id] = target;
      else unsupported++;
    }
    setChoices(next);
    setBulkNote(
      unsupported > 0
        ? `${unsupported} selected group${unsupported === 1 ? " doesn't" : "s don't"} support "${ACTION_LABEL[bulkChoice as SpeedReviewChoice]}" and kept ${unsupported === 1 ? "its" : "their"} current action.`
        : null
    );
  }

  function showSaved(res: BulkReviewResponse) {
    setResults(new Map(res.results.map((r) => [r.groupId, r])));
    setGroupErrors(new Map());
    if (res.results.some((r) => r.ok)) onApplied();
  }

  // The server is all-or-nothing, but when its answer never arrives
  // (timeout, dropped connection, a proxy error page during a deploy) the
  // browser can't know which happened. Ask: reload the review and see
  // whether the submitted groups are still pending.
  async function settleUnknownOutcome(submittedIds: string[], why: string) {
    const params = new URLSearchParams({ date });
    if (employeeId) params.set("employeeId", employeeId);
    try {
      const fresh = await api<SpeedReviewGroupsResponse>(`/api/row-completions/review-groups?${params.toString()}`);
      const stillPending = new Set(fresh.groups.map((g) => g.id));
      const pending = submittedIds.filter((id) => stillPending.has(id));
      if (pending.length === 0) {
        showSaved({ saved: true, results: submittedIds.map((groupId) => ({ groupId, ok: true })) });
        setSubmitError(`${why}, but the review shows all ${submittedIds.length} selected groups were saved.`);
      } else if (pending.length === submittedIds.length) {
        setSubmitError(`${why}. Nothing was saved — all ${submittedIds.length} selected groups are still pending. Your selections are kept; applying again is safe.`);
      } else {
        setSubmitError(
          `${why}. ${submittedIds.length - pending.length} of the selected groups are no longer pending (possibly resolved by another review). Reload the review to see the current state before applying again.`
        );
      }
    } catch {
      setSubmitError(
        `${why}, and the review couldn't be reloaded to check what was saved. Changes are saved all-or-nothing, so applying again is safe — groups that were already saved won't be counted twice.`
      );
    }
  }

  async function handleApply() {
    if (submittingRef.current || toApply.length === 0 || !canApply) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    setGroupErrors(new Map());
    const submittedIds = toApply.map((g) => g.id);
    try {
      const res = await api<BulkReviewResponse>("/api/row-completions/bulk-review", {
        method: "POST",
        timeoutMs: BULK_APPLY_TIMEOUT_MS,
        body: JSON.stringify({
          date,
          groups: toApply.map((g) => ({
            groupId: g.id,
            action: choices[g.id],
            visits: g.visits.map((v) => v.segmentIds),
          })),
        }),
      });
      showSaved(res);
    } catch (err) {
      const body = err instanceof ApiError ? (err.body as Partial<BulkReviewResponse> & { code?: string } | undefined) : undefined;
      if (err instanceof ApiError && body && body.saved === false) {
        // The server refused the batch and saved nothing; it says why, per
        // group. Stale groups are deselected, everything else stays chosen.
        const errors = new Map<string, string>();
        for (const r of body.results ?? []) if (r.error) errors.set(r.groupId, r.error);
        setGroupErrors(errors);
        if (body.code === "BULK_REVIEW_STALE") {
          const blocked = new Set((body.results ?? []).filter((r) => r.status === "stale" || r.status === "invalid").map((r) => r.groupId));
          setSelected((prev) => new Set([...prev].filter((id) => !blocked.has(id))));
        }
        setSubmitError(err.message);
      } else {
        const why =
          err instanceof ApiError
            ? `The server didn't confirm the result (HTTP ${err.status})`
            : (err as { timeout?: boolean })?.timeout
            ? "The server took too long to confirm the result"
            : "The connection was lost before the server confirmed the result";
        await settleUnknownOutcome(submittedIds, why);
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const succeeded = results ? [...results.values()].filter((r) => r.ok).length : 0;
  const failed = results ? [...results.values()].filter((r) => !r.ok).length : 0;
  const title = employeeId ? `Review speeds — ${employeeName ?? "Employee"}` : "Review speeds — all employees";

  const footer = (
    <div className="speed-review-footer">
      <span className="speed-review-footer-summary" role="status">
        {applied
          ? `${succeeded} saved · ${failed} not saved${failed > 0 ? " (still pending)" : ""}`
          : `${groupsLabel(toMerge)} to merge · ${groupsLabel(toSeparate)} to keep separate · ${pendingAfter} pending · ${affectedEmployees} employee${affectedEmployees === 1 ? "" : "s"} affected`}
        {!canApply && " · Only administrators can apply changes"}
      </span>
      {applied ? (
        <>
          <button type="button" onClick={() => setLoadSeq((n) => n + 1)}>
            Reload review
          </button>
          <button type="button" className="employees-add-button" onClick={onClose}>
            Close
          </button>
        </>
      ) : (
        <>
          <button type="button" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="employees-add-button"
            disabled={!canApply || submitting || toApply.length === 0}
            onClick={handleApply}
          >
            {submitting ? "Applying…" : "Apply changes"}
          </button>
        </>
      )}
    </div>
  );

  return (
    <Modal title={title} onClose={submitting ? () => {} : onClose} xxl footer={groups && groups.length > 0 ? footer : undefined}>
      <p className="field-hint">
        {formatDateLong(date)} · Each card is one employee's visits to one row that need review. Merging counts the row once
        over the combined work time; keeping separate counts each visit on its own. Original activity logs are never changed.
      </p>

      {loadError && <p className="error-text">{loadError}</p>}
      {submitError && (
        <p className="error-text" role="alert">
          {submitError}
        </p>
      )}

      {!groups && !loadError ? (
        <p>Loading...</p>
      ) : groups && groups.length === 0 ? (
        <p className="placeholder-page">Nothing needs speed review on this date.</p>
      ) : groups ? (
        <>
          <div className="speed-review-toolbar">
            <button type="button" disabled={locked || eligibleIds.length === 0} onClick={() => setSelected(new Set(eligibleIds))}>
              Select all eligible ({eligibleIds.length})
            </button>
            <button type="button" disabled={locked || selected.size === 0} onClick={() => setSelected(new Set())}>
              Deselect all
            </button>
            <label className="speed-review-bulk">
              Set selected to
              <select value={bulkChoice} disabled={locked} onChange={(e) => setBulkChoice(e.target.value as BulkChoice)}>
                <option value="suggested">Suggested action</option>
                <option value="merge">{ACTION_LABEL.merge}</option>
                <option value="separate">{ACTION_LABEL.separate}</option>
                <option value="skip">{ACTION_LABEL.skip}</option>
              </select>
            </label>
            <button type="button" disabled={locked || selected.size === 0} onClick={applyBulkChoice}>
              Set action
            </button>
          </div>
          {bulkNote && <p className="field-hint">{bulkNote}</p>}

          <div className="speed-review-list">
            {byEmployee.map(([empId, { name, groups: empGroups }]) => (
              <section key={empId} className="speed-review-employee" aria-label={name}>
                {!employeeId && (
                  <h3 className="speed-review-employee-name">
                    {name} <span className="speed-review-count">{empGroups.length}</span>
                  </h3>
                )}
                {empGroups.map((g) => (
                  <ReviewCard
                    key={g.id}
                    group={g}
                    windowDays={windowDays}
                    selected={selected.has(g.id)}
                    choice={choices[g.id] ?? "skip"}
                    expanded={expanded.has(g.id)}
                    locked={locked}
                    result={results?.get(g.id) ?? null}
                    error={groupErrors.get(g.id) ?? null}
                    onToggleSelected={() => toggleSelected(g.id)}
                    onToggleExpanded={() => toggleExpanded(g.id)}
                    onChoose={(c) => setChoices((prev) => ({ ...prev, [g.id]: c }))}
                  />
                ))}
              </section>
            ))}
          </div>
        </>
      ) : null}
    </Modal>
  );
}

interface ReviewCardProps {
  group: SpeedReviewGroup;
  windowDays: number;
  selected: boolean;
  choice: SpeedReviewChoice;
  expanded: boolean;
  locked: boolean;
  result: BulkReviewResult | null;
  // Why a refused apply couldn't save this group (nothing was saved).
  error: string | null;
  onToggleSelected: () => void;
  onToggleExpanded: () => void;
  onChoose: (c: SpeedReviewChoice) => void;
}

function ReviewCard({ group: g, windowDays, selected, choice, expanded, locked, result, error, onToggleSelected, onToggleExpanded, onChoose }: ReviewCardProps) {
  const eligible = isEligible(g);
  const carriers = [...new Set(g.visits.flatMap((v) => v.carriers))];
  const totalSeconds = g.visits.reduce((s, v) => s + v.durationSeconds, 0);
  const preview =
    choice === "merge" && g.actions.merge.preview
      ? previewText(g.actions.merge.preview, g.unit)
      : choice === "separate" && g.actions.separate.previews
      ? g.actions.separate.previews.map((p) => previewText(p, g.unit)).join(" · ")
      : null;

  return (
    <article
      className={`speed-review-card${selected ? " speed-review-card-selected" : ""}${!eligible ? " speed-review-card-pending" : ""}`}
      aria-label={`${g.employeeName} · ${g.rowLabel}`}
    >
      <div className="speed-review-card-head">
        <input
          type="checkbox"
          aria-label={`Select ${g.rowLabel} for ${g.employeeName}`}
          checked={selected}
          disabled={locked || !eligible}
          onChange={onToggleSelected}
        />
        <div className="speed-review-card-title">
          <span>
            <strong>{g.rowLabel}</strong> · {g.activityName}
            {g.spansDates.length > 1 && (
              <span className="speed-review-spans" title={g.spansDates.map(formatDateLong).join(", ")}>
                Spans {g.spansDates.length} days · {g.spansDates.map(shortDate).join(", ")}
              </span>
            )}
          </span>
          <span className="speed-review-card-meta">
            {g.employeeName} · {carriers.length ? carriers.join(", ") : "No carrier"} · {g.visits.length} visit
            {g.visits.length === 1 ? "" : "s"} ·{" "}
            {g.visits.map((v) => (g.spansDates.length > 1 ? `${shortDate(v.date)} ${timeRange(v)}` : timeRange(v))).join(", ")} ·{" "}
            {formatDurationHMS(totalSeconds)} work
          </span>
        </div>
        {result ? (
          <span className={result.ok ? "speed-review-result-ok" : "speed-review-result-failed"} role="status">
            {result.ok ? (result.alreadySaved ? "Already saved" : "Saved") : "Not saved"}
          </span>
        ) : error ? (
          <span className="speed-review-result-failed" role="status">
            Not saved
          </span>
        ) : (
          <span className="inputs-row-completion-warning">Needs review</span>
        )}
        <button type="button" className="speed-review-expand" aria-expanded={expanded} onClick={onToggleExpanded}>
          {expanded ? "Hide details" : "Details"}
        </button>
      </div>

      <p className="speed-review-reason">{g.reasons.join(" ")}</p>

      {eligible ? (
        <div className="speed-review-actions" role="radiogroup" aria-label={`Action for ${g.rowLabel}`}>
          {(["merge", "separate", "skip"] as SpeedReviewChoice[]).map((c) => {
            const supported = isSupported(g, c);
            return (
              <label
                key={c}
                className={`speed-review-action${choice === c ? " speed-review-action-chosen" : ""}${!supported ? " speed-review-action-disabled" : ""}`}
                title={!supported && c !== "skip" ? g.actions[c].unavailableReason ?? undefined : undefined}
              >
                <input type="radio" name={`action-${g.id}`} checked={choice === c} disabled={locked || !supported} onChange={() => onChoose(c)} />
                {ACTION_LABEL[c]}
                {g.suggestedAction === c && <span className="speed-review-suggested">suggested</span>}
              </label>
            );
          })}
        </div>
      ) : (
        <p className="speed-review-unavailable">
          Can't be resolved here yet: {g.actions.separate.unavailableReason ?? g.actions.merge.unavailableReason}
        </p>
      )}

      {preview && <p className="speed-review-preview">Result: {preview}</p>}
      {(result && !result.ok ? result.error : error) && (
        <p className="error-text" role="alert">
          {result && !result.ok ? result.error : error}
        </p>
      )}

      {expanded && (
        <div className="speed-review-details">
          <table className="employees-table speed-review-table">
            <caption>Visits in this group</caption>
            <thead>
              <tr>
                <th>Date</th>
                <th>Start – end</th>
                <th>Work time</th>
                <th>Carrier / bin</th>
                <th>Per row</th>
                <th>Segments</th>
              </tr>
            </thead>
            <tbody>
              {g.visits.map((v) => (
                <tr key={v.visitId}>
                  <td>{formatDateLong(v.date)}</td>
                  <td>{timeRange(v)}</td>
                  <td>{formatDurationHMS(v.durationSeconds)}</td>
                  <td>{v.carriers.join(", ") || "—"}</td>
                  <td>{v.quantityPerRow ?? "mixed"}</td>
                  <td>{v.segmentIds.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {g.contextVisits.length > 0 && (
            <table className="employees-table speed-review-table speed-review-context">
              <caption>Also in this {windowDays}-day row cycle — shown for context, not changed</caption>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Date</th>
                  <th>Start – end</th>
                  <th>Work time</th>
                  <th>Carrier / bin</th>
                </tr>
              </thead>
              <tbody>
                {g.contextVisits.map((v) => (
                  <tr key={v.visitId}>
                    <td>{v.employeeName}</td>
                    <td>{formatDateLong(v.date)}</td>
                    <td>{timeRange(v)}</td>
                    <td>{formatDurationHMS(v.durationSeconds)}</td>
                    <td>{v.carriers.join(", ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <ul className="speed-review-action-notes">
            <li>
              {ACTION_LABEL.merge}:{" "}
              {g.actions.merge.preview ? previewText(g.actions.merge.preview, g.unit) : g.actions.merge.unavailableReason}
            </li>
            <li>
              {ACTION_LABEL.separate}:{" "}
              {g.actions.separate.previews
                ? g.actions.separate.previews.map((p) => previewText(p, g.unit)).join(" · ")
                : g.actions.separate.unavailableReason}
            </li>
          </ul>
        </div>
      )}
    </article>
  );
}
