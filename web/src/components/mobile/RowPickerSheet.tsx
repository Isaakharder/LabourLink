import { useEffect, useMemo, useRef, useState } from "react";
import { Language, t } from "../../lib/i18n";
import { isNfcSupported, ScannedTag, startScanSession } from "../../lib/nfc";
import { resolveScannedTag, ResolvedTagTarget } from "../../lib/nfcMappingCache";

export interface RowPickerRow {
  id: string;
  rowNumber: number;
}

export interface RowPickerPhase {
  id: string;
  name: string;
  rows: RowPickerRow[];
}

export interface RowPickerLand {
  id: string;
  name: string;
  phases: RowPickerPhase[];
}

interface RowPickerSheetProps {
  activityName: string;
  questionLabel: string;
  // Present only inside a multi-question flow ("Step 1 of 2") — a
  // single-question activity's sheet omits it.
  stepLabel?: string;
  // True when the activity's question has is_required = false — shows a
  // "Skip" action that starts the activity with greenhouseRowId = null.
  // Required questions never render Skip, so the sheet can't be dismissed
  // into a started entry without a row.
  allowSkip: boolean;
  // Pre-selects a row (and, once lands have loaded, auto-drills into its
  // land/phase) when navigating back to this step in a multi-question flow
  // — undefined/null on first visit.
  initialSelectedRowId?: string | null;
  lands: RowPickerLand[] | null; // null = still loading
  error: string | null;
  busy: boolean;
  onConfirm: (rowId: string) => void;
  onSkip: () => void;
  // Present only inside a multi-question flow, when this isn't the first
  // question — goes back to the previous question without losing this
  // step's own in-progress selection (the caller re-renders with
  // initialSelectedRowId set on return, see HomeScreen's question-flow
  // state).
  onBack?: () => void;
  onCancel: () => void;
  language: Language;
  // When provided, a resolved NFC scan is handed entirely to the caller
  // (business-rule checks, auto-submit, loading state — see HomeScreen's
  // handleNfcScan) instead of this sheet's own default "just select the
  // row" behavior. Omitted by the admin registration screens, which reuse
  // this sheet purely for manual target selection and want the original
  // behavior unchanged.
  onNfcScan?: (resolved: ResolvedTagTarget) => void;
}

// Same bottom-sheet visual pattern as ActivityPicker/ConfirmEndDayModal
// (.mobile-sheet* classes) for consistency. Two-step select-then-confirm
// (tap highlights, Confirm submits) rather than submit-on-tap — this opens
// a real work entry, so a tap should be reviewable before it commits.
// One phase, flattened out of whichever land it belongs to, plus enough of
// that land's identity to disambiguate it on screen — see flattenPhases
// below. The land itself is never a separate navigation step; it's resolved
// automatically (this record, and ultimately the row's own greenhouse_row_id
// FK) rather than asked about.
interface FlatPhase {
  id: string;
  name: string;
  landId: string;
  landName: string;
  // True only when another phase (in a different land) shares this exact
  // name — see flattenPhases. When false, the land name is redundant
  // information (there's nothing to disambiguate) and stays hidden.
  showLandName: boolean;
  rows: RowPickerRow[];
}

// Activity -> Phase -> Row, with Land resolved internally rather than
// presented as its own screen (see this file's header comment for why: the
// employee only ever cares which physical phase/row they're at, never which
// land contains it — a Land-selection step was pure extra navigation for
// zero decision value, even in the single-land case this app runs today).
// One combined, flat phase list is built here regardless of how many lands
// exist; a phase name that's unique across every land renders on its own,
// and one that collides with a same-named phase in a different land gets
// " — <land name>" appended so the two are never ambiguous on screen (e.g.
// "Phase 1 — First Light Greenhouse" vs "Phase 1 — Second Property").
function flattenPhases(lands: RowPickerLand[]): FlatPhase[] {
  const nameCounts = new Map<string, number>();
  for (const land of lands) {
    for (const phase of land.phases) {
      nameCounts.set(phase.name, (nameCounts.get(phase.name) ?? 0) + 1);
    }
  }
  const flat: FlatPhase[] = [];
  for (const land of lands) {
    for (const phase of land.phases) {
      flat.push({
        id: phase.id,
        name: phase.name,
        landId: land.id,
        landName: land.name,
        showLandName: (nameCounts.get(phase.name) ?? 0) > 1,
        rows: phase.rows,
      });
    }
  }
  return flat;
}

function phaseDisplayName(phase: FlatPhase): string {
  return phase.showLandName ? `${phase.name} — ${phase.landName}` : phase.name;
}

export function RowPickerSheet({
  activityName,
  questionLabel,
  stepLabel,
  allowSkip,
  initialSelectedRowId,
  lands,
  error,
  busy,
  onConfirm,
  onSkip,
  onBack,
  onCancel,
  language,
  onNfcScan,
}: RowPickerSheetProps) {
  const [expandedPhaseId, setExpandedPhaseId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedRowId, setSelectedRowId] = useState<string | null>(initialSelectedRowId ?? null);
  const [nfcActive, setNfcActive] = useState(false);
  const [nfcHint, setNfcHint] = useState<string | null>(null);

  const phases = useMemo(() => (lands ? flattenPhases(lands) : null), [lands]);

  // Read inside the NFC scan callback below instead of `phases` directly —
  // the callback is registered once (see the scan effect's `[]` deps, so a
  // held-open scan session survives `lands` finishing its async load
  // without being torn down and restarted) but still needs whichever
  // flattened phase list is current at the moment a tag actually resolves.
  const phasesRef = useRef(phases);
  useEffect(() => {
    phasesRef.current = phases;
  }, [phases]);

  // Same reasoning as phasesRef — onNfcScan is typically a fresh closure
  // every render (it captures HomeScreen's current questionFlow/busy/etc.),
  // but the scan effect below only runs once per mount.
  const onNfcScanRef = useRef(onNfcScan);
  useEffect(() => {
    onNfcScanRef.current = onNfcScan;
  }, [onNfcScan]);

  // Navigating back to this step (Back, from a later question) restores not
  // just the highlighted row but the drill-down that makes it visible —
  // otherwise "Back preserves prior answer" would be true only in state, not
  // on screen, for anyone who'd drilled into a specific phase to pick it.
  // Runs once lands finish loading; a no-op on first visit (no prior
  // selection) or once already drilled in. Land is never part of this
  // restoration — there's no land-level navigation state to restore.
  useEffect(() => {
    if (!phases || !initialSelectedRowId || expandedPhaseId) return;
    const phase = phases.find((p) => p.rows.some((r) => r.id === initialSelectedRowId));
    if (phase) setExpandedPhaseId(phase.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phases]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel]);

  // NFC scan session lives exactly as long as this sheet does — started on
  // mount, stopped on unmount (Cancel, Confirm, Back, or the parent closing
  // it for any other reason all unmount this component the same way) — so a
  // tag tapped after the employee has moved on can never affect a selection
  // it wasn't open for. When onNfcScan is provided (the employee flow), a
  // resolved tag is handed entirely to the caller — auto-submit, warning
  // dialogs, and loading state are HomeScreen's responsibility, not this
  // generic picker's. Without it (the admin registration screens), a
  // resolved tag only *selects* the row (same as a manual tap), never
  // auto-confirms — see this sheet's existing select-then-confirm design
  // (header comment above), unchanged for that case.
  useEffect(() => {
    let cancelled = false;
    let stopScan: (() => void) | null = null;
    let waitingTimer: ReturnType<typeof setTimeout> | null = null;

    (async () => {
      const supported = await isNfcSupported();
      if (cancelled || !supported) return;
      setNfcActive(true);
      waitingTimer = setTimeout(() => {
        if (!cancelled) setNfcHint(t(language, "nfcStillWaiting"));
      }, 15000);

      stopScan = startScanSession((tag: ScannedTag) => {
        const resolved = resolveScannedTag(tag);
        if (!resolved || resolved.targetType !== "greenhouse_row") {
          setNfcHint(t(language, "nfcTagNotRecognized"));
          return;
        }
        setNfcHint(null);

        if (onNfcScanRef.current) {
          onNfcScanRef.current(resolved);
          return;
        }

        setSelectedRowId(resolved.targetId);
        const phase = (phasesRef.current ?? []).find((p) => p.rows.some((r) => r.id === resolved.targetId));
        if (phase) setExpandedPhaseId(phase.id);
      }, undefined, "RowPickerSheet");
    })();

    return () => {
      cancelled = true;
      if (waitingTimer) clearTimeout(waitingTimer);
      stopScan?.();
    };
    // language is read inside the callback via closure — re-subscribing the
    // whole scan session on a language change (which can't happen mid-sheet
    // anyway, it's fixed per employee) isn't worth guarding against.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const searchResults = useMemo(() => {
    if (!phases || !search.trim()) return null;
    const q = search.trim();
    const results: { phaseName: string; row: RowPickerRow }[] = [];
    for (const phase of phases) {
      for (const row of phase.rows) {
        if (String(row.rowNumber).startsWith(q)) {
          results.push({ phaseName: phaseDisplayName(phase), row });
        }
      }
    }
    return results;
  }, [phases, search]);

  const expandedPhase = phases?.find((p) => p.id === expandedPhaseId) ?? null;
  // Only one navigation level ever needs backing out of now — Phase -> Row.
  // There's no Land level to back out of (Activity -> Phase -> Row, per this
  // file's header comment), so Back only ever appears once a phase is
  // expanded into its row grid.
  const showBack = Boolean(expandedPhase);

  function handleBack() {
    setExpandedPhaseId(null);
  }

  function handleConfirm() {
    if (selectedRowId) onConfirm(selectedRowId);
  }

  function rowButton(row: RowPickerRow, phaseName?: string) {
    const selected = row.id === selectedRowId;
    return (
      <button
        key={row.id}
        type="button"
        className={`mobile-row-grid-item${selected ? " mobile-row-grid-item-selected" : ""}`}
        disabled={busy}
        onClick={() => setSelectedRowId(row.id)}
      >
        <span className="mobile-row-grid-item-number">{row.rowNumber}</span>
        {phaseName && <span className="mobile-row-grid-item-phase">{phaseName}</span>}
      </button>
    );
  }

  return (
    <div className="mobile-sheet-backdrop" onClick={busy ? undefined : onCancel}>
      <div
        className="mobile-sheet"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={questionLabel}
      >
        <div className="mobile-sheet-header">
          <div>
            {stepLabel && <p className="mobile-step-indicator">{stepLabel}</p>}
            <h2>{questionLabel}</h2>
            <p className="mobile-row-picker-subtitle">{activityName}</p>
          </div>
          {!busy && (
            <button type="button" className="mobile-sheet-close" onClick={onCancel} aria-label={t(language, "close")}>
              ×
            </button>
          )}
        </div>

        {error && <p className="error-text">{error}</p>}
        {nfcActive && (
          <p className="mobile-row-picker-subtitle">{busy ? t(language, "starting") : nfcHint ?? t(language, "tapRowTag")}</p>
        )}

        {!phases ? (
          <p className="mobile-sheet-empty">{t(language, "loadingRows")}</p>
        ) : phases.length === 0 ? (
          <p className="mobile-sheet-empty">{t(language, "noRowsMessage")}</p>
        ) : (
          <>
            <div className="mobile-row-search">
              <input
                type="search"
                inputMode="numeric"
                placeholder={t(language, "searchRowNumber")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                disabled={busy}
              />
            </div>

            {showBack && !search && (
              <button type="button" className="mobile-row-back" onClick={handleBack} disabled={busy}>
                {t(language, "backDrillDown")}
              </button>
            )}

            {searchResults ? (
              searchResults.length === 0 ? (
                <p className="mobile-sheet-empty">{t(language, "noMatchingRows")}</p>
              ) : (
                <div className="mobile-row-grid">
                  {searchResults.map(({ row, phaseName }) => rowButton(row, phaseName))}
                </div>
              )
            ) : expandedPhase ? (
              expandedPhase.rows.length === 0 ? (
                <p className="mobile-sheet-empty">{t(language, "noRowsInPhase")}</p>
              ) : (
                <div className="mobile-row-grid">{expandedPhase.rows.map((row) => rowButton(row))}</div>
              )
            ) : (
              // The combined phase list — every active phase from every
              // active land, flattened (see flattenPhases above). Never a
              // land-selection screen, regardless of how many lands exist.
              <div className="mobile-sheet-list">
                {phases.map((phase) => (
                  <button
                    key={phase.id}
                    type="button"
                    className="mobile-action-button mobile-sheet-item"
                    disabled={busy}
                    onClick={() => setExpandedPhaseId(phase.id)}
                  >
                    <span className="mobile-sheet-item-name">{phaseDisplayName(phase)}</span>
                    <span className="mobile-sheet-item-secondary">
                      {t(language, "rowsCount", { count: phase.rows.length })}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {/* Rendered regardless of loading/empty state — Skip never depends
            on rows having loaded, and Cancel must always be reachable.
            Confirm only makes sense once there's something to select from. */}
        <div className="mobile-confirm-actions">
          {phases && phases.length > 0 && (
            <button
              type="button"
              className="mobile-action-button mobile-action-primary"
              disabled={busy || !selectedRowId}
              onClick={handleConfirm}
            >
              {busy ? t(language, "starting") : t(language, "confirm")}
            </button>
          )}
          {allowSkip && (
            <button type="button" className="mobile-action-button" disabled={busy} onClick={onSkip}>
              {t(language, "skipNoRow")}
            </button>
          )}
          {onBack && (
            <button type="button" className="mobile-action-button" disabled={busy} onClick={onBack}>
              {t(language, "back")}
            </button>
          )}
          <button type="button" className="mobile-action-button" disabled={busy} onClick={onCancel}>
            {t(language, "cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
