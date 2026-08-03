import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { api, ApiError } from "../../../lib/api";
import { AppShellContext } from "../../../components/layout/AppLayout";
import { GreenhouseLand, GreenhouseLandListItem, GreenhousePhase } from "../../../lib/greenhouseLayoutTypes";
import { CanvasTransform, computeFitTransform, zoomAtPoint } from "../../../lib/canvasTransform";
import { isTypingIntoFormField } from "../../../lib/isTypingTarget";
import { LayoutToolbar } from "../../../components/greenhouseLayout/LayoutToolbar";
import { LandCanvas } from "../../../components/greenhouseLayout/LandCanvas";
import { NorthIndicator } from "../../../components/greenhouseLayout/NorthIndicator";
import { LandFormModal } from "../../../components/greenhouseLayout/LandFormModal";
import { PhaseFormModal } from "../../../components/greenhouseLayout/PhaseFormModal";
import { PhaseList } from "../../../components/greenhouseLayout/PhaseList";
import { PhasePositionEditor } from "../../../components/greenhouseLayout/PhasePositionEditor";

type PhaseModalState = { mode: "create" } | { mode: "edit"; phase: GreenhousePhase } | null;

const NICE_GRID_STEPS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];
const ZOOM_BUTTON_FACTOR = 1.2;

function overlapInfoFor(phases: GreenhousePhase[]) {
  const ids = new Set<string>();
  const warnings: string[] = [];
  const active = phases.filter((p) => p.isActive);
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      const overlapX =
        Math.min(a.xFeetFromWest + a.eastWestFeet, b.xFeetFromWest + b.eastWestFeet) -
        Math.max(a.xFeetFromWest, b.xFeetFromWest);
      const overlapY =
        Math.min(a.yFeetFromNorth + a.northSouthFeet, b.yFeetFromNorth + b.northSouthFeet) -
        Math.max(a.yFeetFromNorth, b.yFeetFromNorth);
      if (overlapX > 0 && overlapY > 0) {
        ids.add(a.id);
        ids.add(b.id);
        warnings.push(
          `${a.name} overlaps ${b.name} by approximately ${Math.round(overlapX * overlapY).toLocaleString()} sq ft.`
        );
      }
    }
  }
  return { ids, warnings };
}

export function GreenhouseLayoutTab() {
  const navigate = useNavigate();
  const { sidebarHidden, setSidebarHidden, setContentFullBleed } = useOutletContext<AppShellContext>();

  const [lands, setLands] = useState<GreenhouseLandListItem[] | null>(null);
  const [landId, setLandId] = useState<string | null>(null);
  const [land, setLand] = useState<GreenhouseLand | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [draftPhases, setDraftPhases] = useState<GreenhousePhase[]>([]);
  const [editMode, setEditMode] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [positionEditId, setPositionEditId] = useState<string | null>(null);
  const [moveStep, setMoveStep] = useState(1);
  const [snapEnabled, setSnapEnabled] = useState(false);
  const [preventOverlap, setPreventOverlap] = useState(false);
  const [liveCoordinates, setLiveCoordinates] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [landModalMode, setLandModalMode] = useState<"create" | "edit" | null>(null);
  const [phaseModal, setPhaseModal] = useState<PhaseModalState>(null);

  // Pan/zoom view state — see lib/canvasTransform.ts. Lives here (not in
  // LandCanvas) so the toolbar's zoom buttons and keyboard shortcuts drive
  // the exact same state the canvas's own wheel/drag gestures do.
  const [transform, setTransform] = useState<CanvasTransform>({ pan: { x: 0, y: 0 }, scale: 1 });
  const [fitScale, setFitScale] = useState(1);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const autoFitLandIdRef = useRef<string | null>(null);

  // Full-screen drawing-app shell: go full-bleed (no admin-page padding or
  // scrollbar) and lock page scrolling for as long as this tab is mounted;
  // always restore both, and the sidebar, on the way out — including via
  // Back, a sidebar nav click, or the browser back button — so no other
  // page can ever be left in this state.
  useEffect(() => {
    setContentFullBleed(true);
    return () => {
      setContentFullBleed(false);
      setSidebarHidden(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const loadLandsList = useCallback(async () => {
    try {
      const res = await api<{ lands: GreenhouseLandListItem[] }>("/api/greenhouse-layout/lands");
      setLands(res.lands);
      setLoadError(null);
      if (res.lands.length === 0) {
        setLandId(null);
        setLand(null);
        return;
      }
      const chosen = res.lands.find((l) => l.isActive) ?? res.lands[0];
      setLandId(chosen.id);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load greenhouse lands");
    }
  }, []);

  // Returns the freshly loaded land (or null on failure) so callers that
  // need to act on the up-to-date data immediately — e.g. re-fitting the
  // view after an edit — don't have to read it back from a `land` state
  // closure that may not have re-rendered yet.
  const loadLandDetail = useCallback(async (id: string) => {
    try {
      const res = await api<{ land: GreenhouseLand }>(`/api/greenhouse-layout/lands/${id}`);
      setLand(res.land);
      setDraftPhases(res.land.phases);
      setLoadError(null);
      return res.land;
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load the land layout");
      return null;
    }
  }, []);

  useEffect(() => {
    loadLandsList();
  }, [loadLandsList]);

  useEffect(() => {
    if (landId) loadLandDetail(landId);
  }, [landId, loadLandDetail]);

  const gridFeet = useMemo(() => {
    if (!land) return 25;
    const smaller = Math.min(land.eastWestFeet, land.northSouthFeet);
    const raw = smaller / 15;
    return NICE_GRID_STEPS.find((s) => s >= raw) ?? NICE_GRID_STEPS[NICE_GRID_STEPS.length - 1];
  }, [land]);

  const overlapInfo = useMemo(() => overlapInfoFor(draftPhases), [draftPhases]);
  const overlapBlocked = preventOverlap && overlapInfo.warnings.length > 0;

  const hasDraftChanges = useMemo(() => {
    if (!land) return false;
    return draftPhases.some((dp) => {
      const orig = land.phases.find((p) => p.id === dp.id);
      return orig && (orig.xFeetFromWest !== dp.xFeetFromWest || orig.yFeetFromNorth !== dp.yFeetFromNorth);
    });
  }, [draftPhases, land]);

  const selectedPhase = draftPhases.find((p) => p.id === selectedId) ?? null;

  const minScale = fitScale * 0.15;
  const maxScale = fitScale * 6;
  const zoomPercent = fitScale > 0 ? Math.round((transform.scale / fitScale) * 100) : 100;

  const fitToScreen = useCallback(
    (width = viewportSize.width, height = viewportSize.height) => {
      if (!land || width <= 0 || height <= 0) return;
      const fit = computeFitTransform(land, width, height);
      setFitScale(fit.scale);
      setTransform(fit);
    },
    [land, viewportSize.width, viewportSize.height]
  );

  function handleViewportSize(size: { width: number; height: number }) {
    setViewportSize(size);
    // Auto-fit once per land load (first time we know the real viewport
    // size) — never on a bare resize afterward, per "don't reset zoom/pan
    // unexpectedly unless Fit to screen is pressed."
    if (land && autoFitLandIdRef.current !== land.id && size.width > 0 && size.height > 0) {
      autoFitLandIdRef.current = land.id;
      const fit = computeFitTransform(land, size.width, size.height);
      setFitScale(fit.scale);
      setTransform(fit);
    }
  }

  function zoomByFactor(factor: number) {
    const newScale = Math.min(maxScale, Math.max(minScale, transform.scale * factor));
    setTransform(zoomAtPoint(transform, newScale, viewportSize.width / 2, viewportSize.height / 2));
  }

  function handleDragMove(id: string, x: number, y: number) {
    setDraftPhases((prev) => prev.map((p) => (p.id === id ? { ...p, xFeetFromWest: x, yFeetFromNorth: y } : p)));
    setLiveCoordinates(`${Math.round(x)} ft from west, ${Math.round(y)} ft from north`);
  }

  // Selecting a different phase while one is mid-position-edit discards its
  // unsaved draft (same as an explicit Cancel) rather than leaving it in
  // limbo — only one phase's position can be actively edited at a time.
  function handleSelect(id: string | null) {
    if (positionEditId && id !== positionEditId) {
      cancelPositionEdit();
    }
    setSelectedId(id);
  }

  function startPositionEdit(phase: GreenhousePhase) {
    setSelectedId(phase.id);
    setPositionEditId(phase.id);
    setSaveError(null);
  }

  // Nudges the phase currently in position-edit mode by `step` feet in the
  // given direction, clamped to the land boundary — the same draftPhases
  // array a canvas drag on this phase also writes to, so both interaction
  // methods share one draft.
  function movePhase(dxDirection: -1 | 0 | 1, dyDirection: -1 | 0 | 1, step: number) {
    if (!positionEditId || !land) return;
    setDraftPhases((prev) =>
      prev.map((p) => {
        if (p.id !== positionEditId) return p;
        const maxX = Math.max(0, land.eastWestFeet - p.eastWestFeet);
        const maxY = Math.max(0, land.northSouthFeet - p.northSouthFeet);
        const x = Math.max(0, Math.min(p.xFeetFromWest + dxDirection * step, maxX));
        const y = Math.max(0, Math.min(p.yFeetFromNorth + dyDirection * step, maxY));
        return { ...p, xFeetFromWest: x, yFeetFromNorth: y };
      })
    );
  }

  async function savePosition() {
    const phase = draftPhases.find((p) => p.id === positionEditId);
    if (!phase || !land) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api(`/api/greenhouse-layout/phases/${phase.id}/position`, {
        method: "PATCH",
        body: JSON.stringify({ xFeetFromWest: phase.xFeetFromWest, yFeetFromNorth: phase.yFeetFromNorth }),
      });
      await loadLandDetail(land.id);
      setPositionEditId(null);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Could not save the phase's position");
    } finally {
      setSaving(false);
    }
  }

  function cancelPositionEdit() {
    if (land && positionEditId) {
      const orig = land.phases.find((p) => p.id === positionEditId);
      if (orig) {
        setDraftPhases((prev) => prev.map((p) => (p.id === positionEditId ? { ...orig } : p)));
      }
    }
    setSaveError(null);
    setPositionEditId(null);
  }

  function handleToggleEditMode() {
    if (editMode && hasDraftChanges) {
      const proceed = window.confirm("You have unsaved position changes. Discard them?");
      if (!proceed) return;
      setDraftPhases(land!.phases);
    }
    setLiveCoordinates(null);
    setSaveError(null);
    setEditMode((v) => !v);
  }

  async function handleSaveLayout() {
    if (!land) return;
    // Guards here too, not just the toolbar button's disabled state — this
    // is also reachable via the Ctrl/Cmd+S shortcut, which bypasses that.
    if (overlapBlocked) {
      setSaveError("Resolve overlapping phases before saving, or turn off Prevent overlap.");
      return;
    }
    const changed = draftPhases.filter((dp) => {
      const orig = land.phases.find((p) => p.id === dp.id);
      return orig && (orig.xFeetFromWest !== dp.xFeetFromWest || orig.yFeetFromNorth !== dp.yFeetFromNorth);
    });
    if (changed.length === 0) return;

    setSaving(true);
    setSaveError(null);
    try {
      await api(`/api/greenhouse-layout/lands/${land.id}/phase-positions`, {
        method: "PATCH",
        body: JSON.stringify({
          positions: changed.map((p) => ({ id: p.id, xFeetFromWest: p.xFeetFromWest, yFeetFromNorth: p.yFeetFromNorth })),
        }),
      });
      await loadLandDetail(land.id);
      setLiveCoordinates(null);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Could not save the layout");
    } finally {
      setSaving(false);
    }
  }

  function handleCancelChanges() {
    if (!land) return;
    setDraftPhases(land.phases);
    setSaveError(null);
    setLiveCoordinates(null);
  }

  async function handleTogglePhaseActive(phase: GreenhousePhase) {
    if (!land) return;
    try {
      await api(`/api/greenhouse-layout/phases/${phase.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !phase.isActive }),
      });
      await loadLandDetail(land.id);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not update the phase");
    }
  }

  function handleBack() {
    if (hasDraftChanges) {
      const proceed = window.confirm("You have unsaved position changes. Discard them and leave?");
      if (!proceed) return;
    }
    navigate("/setup");
  }

  // Arrow keys nudge the phase in position-edit mode, Shift+arrow uses the
  // larger step, Enter saves, Escape cancels — but never while focus is in
  // a text field/select, so this doesn't fight normal form typing.
  useEffect(() => {
    if (!positionEditId) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (isTypingIntoFormField()) return;

      const step = e.shiftKey ? 10 : moveStep;
      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          movePhase(0, -1, step);
          break;
        case "ArrowDown":
          e.preventDefault();
          movePhase(0, 1, step);
          break;
        case "ArrowLeft":
          e.preventDefault();
          movePhase(-1, 0, step);
          break;
        case "ArrowRight":
          e.preventDefault();
          movePhase(1, 0, step);
          break;
        case "Enter":
          e.preventDefault();
          savePosition();
          break;
        case "Escape":
          e.preventDefault();
          cancelPositionEdit();
          break;
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionEditId, moveStep, land, draftPhases]);

  // Editor-shell-level shortcuts: zoom, fit, save, clear selection. Skipped
  // entirely while the D-pad position editor is active — that effect owns
  // arrows/Enter/Escape for the duration, and Ctrl/Cmd+S there would be
  // ambiguous with Enter's existing save action.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (isTypingIntoFormField()) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (positionEditId) savePosition();
        else if (hasDraftChanges) handleSaveLayout();
        return;
      }
      if (positionEditId) return;

      switch (e.key) {
        case "+":
        case "=":
          e.preventDefault();
          zoomByFactor(ZOOM_BUTTON_FACTOR);
          break;
        case "-":
          e.preventDefault();
          zoomByFactor(1 / ZOOM_BUTTON_FACTOR);
          break;
        case "0":
          e.preventDefault();
          fitToScreen();
          break;
        case "Escape":
          setSelectedId(null);
          break;
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // draftPhases/land/overlapBlocked are here (not just the hasDraftChanges
    // memo derived from them) so a Ctrl/Cmd+S fired mid-drag always saves
    // the latest positions through a fresh handleSaveLayout/savePosition
    // closure, never a stale one from before the drag's last update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    positionEditId,
    hasDraftChanges,
    draftPhases,
    land,
    overlapBlocked,
    transform,
    minScale,
    maxScale,
    viewportSize,
    fitToScreen,
  ]);

  if (!lands) {
    return (
      <div className="greenhouse-editor-shell">
        <p className="greenhouse-editor-loading">Loading...</p>
      </div>
    );
  }

  if (!land) {
    return (
      <div className="greenhouse-editor-shell">
        <div className="greenhouse-toolbar">
          <div className="greenhouse-toolbar-group">
            <button type="button" onClick={handleBack}>
              ← Back
            </button>
            <button type="button" onClick={() => setSidebarHidden(!sidebarHidden)}>
              {sidebarHidden ? "Show navigation" : "Hide navigation"}
            </button>
          </div>
        </div>
        <div className="greenhouse-empty-state">
          {loadError && <p className="error-text">{loadError}</p>}
          <p className="placeholder-page">No greenhouse land has been created yet.</p>
          <button type="button" className="employees-add-button" onClick={() => setLandModalMode("create")}>
            Create Land
          </button>
        </div>
        {landModalMode && (
          <LandFormModal
            land={null}
            onClose={() => setLandModalMode(null)}
            onSaved={() => {
              setLandModalMode(null);
              loadLandsList();
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="greenhouse-editor-shell">
      <LayoutToolbar
        onBack={handleBack}
        sidebarHidden={sidebarHidden}
        onToggleSidebar={() => setSidebarHidden(!sidebarHidden)}
        zoomPercent={zoomPercent}
        onZoomIn={() => zoomByFactor(ZOOM_BUTTON_FACTOR)}
        onZoomOut={() => zoomByFactor(1 / ZOOM_BUTTON_FACTOR)}
        onFitToScreen={() => fitToScreen()}
        snapEnabled={snapEnabled}
        onSnapToggle={setSnapEnabled}
        preventOverlap={preventOverlap}
        onPreventOverlapToggle={setPreventOverlap}
        editMode={editMode}
        onToggleEditMode={handleToggleEditMode}
        hasDraftChanges={hasDraftChanges}
        overlapBlocked={overlapBlocked}
        onSaveLayout={handleSaveLayout}
        onCancelChanges={handleCancelChanges}
        saving={saving}
        pxPerFoot={transform.scale}
        gridFeet={gridFeet}
        liveCoordinates={editMode ? liveCoordinates : null}
      />

      {loadError && <p className="error-text greenhouse-editor-banner">{loadError}</p>}
      {saveError && !positionEditId && <p className="error-text greenhouse-editor-banner">{saveError}</p>}

      <div className="greenhouse-editor-body">
        <div className="greenhouse-left-panel">
          <div className="greenhouse-left-panel-actions">
            <button type="button" onClick={() => setLandModalMode("edit")}>
              Edit Land
            </button>
            <button type="button" className="employees-add-button" onClick={() => setPhaseModal({ mode: "create" })}>
              Create Phase
            </button>
          </div>

          {overlapInfo.warnings.length > 0 && (
            <div className="form-warning">
              {overlapInfo.warnings.map((w) => (
                <p key={w}>{w}</p>
              ))}
            </div>
          )}

          <PhaseList phases={draftPhases} selectedId={selectedId} onSelect={handleSelect} />

          {selectedPhase && positionEditId !== selectedPhase.id && (
            <div className="greenhouse-selected-phase-actions">
              <button type="button" onClick={() => setPhaseModal({ mode: "edit", phase: selectedPhase })}>
                Edit Phase
              </button>
              <button type="button" onClick={() => startPositionEdit(selectedPhase)}>
                Edit Position
              </button>
              <button type="button" onClick={() => handleTogglePhaseActive(selectedPhase)}>
                {selectedPhase.isActive ? "Deactivate" : "Activate"}
              </button>
            </div>
          )}

          {selectedPhase && positionEditId === selectedPhase.id && (
            <PhasePositionEditor
              phase={selectedPhase}
              land={land}
              moveStep={moveStep}
              onStepChange={setMoveStep}
              onMove={movePhase}
              onSave={savePosition}
              onCancel={cancelPositionEdit}
              saving={saving}
              saveError={saveError}
            />
          )}
        </div>

        <div className="greenhouse-canvas-panel">
          <NorthIndicator />
          <LandCanvas
            land={land}
            phases={draftPhases}
            editMode={editMode}
            positionEditId={positionEditId}
            selectedId={selectedId}
            onSelect={handleSelect}
            onDragMove={handleDragMove}
            snapEnabled={snapEnabled}
            gridFeet={gridFeet}
            overlappingPhaseIds={overlapInfo.ids}
            transform={transform}
            onTransformChange={setTransform}
            onViewportSize={handleViewportSize}
            minScale={minScale}
            maxScale={maxScale}
          />
        </div>
      </div>

      {landModalMode && (
        <LandFormModal
          land={landModalMode === "edit" ? land : null}
          onClose={() => setLandModalMode(null)}
          onSaved={async () => {
            // Editing here always targets the currently-loaded land, whose
            // id never changes — the landId-watching effect above wouldn't
            // re-fire for that, so the detail (and the fit/scale derived
            // from its dimensions) has to be refreshed directly rather than
            // going through loadLandsList(). Recomputing the fit from the
            // freshly returned land (not a `land` state closure, which
            // wouldn't have the new dimensions until the next render) keeps
            // the canvas, its boundaries, and the zoom-% display correct
            // immediately — safe to do unconditionally since a same-size
            // edit (e.g. a rename) just recomputes the identical fit.
            setLandModalMode(null);
            const fresh = await loadLandDetail(land.id);
            if (fresh && viewportSize.width > 0 && viewportSize.height > 0) {
              const fit = computeFitTransform(fresh, viewportSize.width, viewportSize.height);
              setFitScale(fit.scale);
              setTransform(fit);
            }
          }}
        />
      )}

      {phaseModal && (
        <PhaseFormModal
          landId={land.id}
          phase={phaseModal.mode === "edit" ? phaseModal.phase : null}
          onClose={() => setPhaseModal(null)}
          onSaved={() => {
            setPhaseModal(null);
            loadLandDetail(land.id);
          }}
        />
      )}
    </div>
  );
}
