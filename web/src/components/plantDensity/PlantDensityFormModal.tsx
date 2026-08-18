import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "../ui/Modal";
import { GreenhouseLiveCanvas } from "../greenhouseLive/GreenhouseLiveCanvas";
import { api, ApiError } from "../../lib/api";
import { CanvasTransform, computeFitTransform } from "../../lib/canvasTransform";
import { PlantDensityDetail, PlantDensityLinkedRow, PlantDensityRowLink, PlantDensityType } from "../../lib/plantDensityTypes";
import { GreenhouseLandListItem, GreenhouseLand, GreenhouseRowListItem } from "../../lib/greenhouseLayoutTypes";
import { LiveLand, LiveRow } from "../../lib/greenhouseLiveTypes";

interface PlantDensityFormModalProps {
  densityId: string | null; // null = create mode
  // Fixed for the whole modal session — a density's type is immutable
  // once created (see 024_plant_density_types.sql), and the card the admin
  // clicked "Create Density" from (or "Edit" on) already determines it, so
  // there's never a case where this needs to be re-derived mid-session.
  type: PlantDensityType;
  onClose: () => void;
  onSaved: () => void;
}

const COUNT_PER_ROW_LABEL: Record<PlantDensityType, string> = {
  plants: "Plants per row",
  stems: "Stems per row",
};

const TYPE_LABEL: Record<PlantDensityType, string> = {
  plants: "Plants",
  stems: "Stems",
};

type Step = "details" | "linkRows";

// Same merge Employee Blocks' buildSelectionLand does — the layout
// editor's land-detail (phase geometry) plus the flat active-rows list,
// both already-existing endpoints, into the LiveLand shape
// GreenhouseLiveCanvas already renders. state/employees are placeholders
// selection mode never reads.
function buildSelectionLand(land: GreenhouseLand, rows: GreenhouseRowListItem[]): LiveLand {
  return {
    id: land.id,
    name: land.name,
    northSouthFeet: land.northSouthFeet,
    eastWestFeet: land.eastWestFeet,
    isActive: land.isActive,
    phases: land.phases.map((phase) => ({
      id: phase.id,
      name: phase.name,
      description: phase.description,
      northSouthFeet: phase.northSouthFeet,
      eastWestFeet: phase.eastWestFeet,
      xFeetFromWest: phase.xFeetFromWest,
      yFeetFromNorth: phase.yFeetFromNorth,
      isActive: phase.isActive,
      sortOrder: phase.sortOrder,
      rows: rows
        .filter((r) => r.phaseId === phase.id)
        .map(
          (r): LiveRow => ({
            id: r.id,
            rowNumber: r.rowNumber,
            xFt: r.xFt,
            yFt: r.yFt,
            widthFt: r.widthFt,
            lengthFt: r.lengthFt,
            orientation: r.orientation,
            state: "neutral",
            employees: [],
            blockId: null,
          })
        ),
    })),
  };
}

export function PlantDensityFormModal({ densityId, type, onClose, onSaved }: PlantDensityFormModalProps) {
  const isEdit = Boolean(densityId);
  const [step, setStep] = useState<Step>("details");

  const [loadingDetail, setLoadingDetail] = useState(isEdit);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [countPerRow, setCountPerRow] = useState("");
  const [linkedRows, setLinkedRows] = useState<PlantDensityLinkedRow[]>([]);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // -- Link Rows step state --
  const [lands, setLands] = useState<GreenhouseLandListItem[] | null>(null);
  const [selectionLandId, setSelectionLandId] = useState<string | null>(null);
  const [selectionLand, setSelectionLand] = useState<LiveLand | null>(null);
  const [rowLinks, setRowLinks] = useState<PlantDensityRowLink[] | null>(null);
  const [draftSelectedIds, setDraftSelectedIds] = useState<Set<string>>(new Set());
  const [linkRowsError, setLinkRowsError] = useState<string | null>(null);
  const [transform, setTransform] = useState<CanvasTransform>({ pan: { x: 0, y: 0 }, scale: 1 });
  const [fitScale, setFitScale] = useState(1);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!densityId) return;
    api<{ density: PlantDensityDetail }>(`/api/plant-densities/${densityId}`)
      .then((res) => {
        setName(res.density.name);
        setCountPerRow(String(res.density.countPerRow));
        setLinkedRows(res.density.rows);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Could not load this density"))
      .finally(() => setLoadingDetail(false));
  }, [densityId]);

  function parsedCountPerRow(): number | null {
    const n = Number(countPerRow);
    if (!Number.isInteger(n) || n <= 0) return null;
    return n;
  }

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "Density name is required";
    if (parsedCountPerRow() === null) next.countPerRow = `${COUNT_PER_ROW_LABEL[type]} must be a whole number greater than 0`;
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitError(null);
    if (!validate()) return;

    setSubmitting(true);
    try {
      const saved = isEdit
        ? await api<{ density: PlantDensityDetail }>(`/api/plant-densities/${densityId}`, {
            method: "PATCH",
            body: JSON.stringify({ name: name.trim(), countPerRow: parsedCountPerRow() }),
          })
        : await api<{ density: PlantDensityDetail }>("/api/plant-densities", {
            method: "POST",
            body: JSON.stringify({ name: name.trim(), type, countPerRow: parsedCountPerRow() }),
          });

      // Linking rows (openLinkRows/confirmLinkRows below) is a purely
      // local draft operation regardless of create vs. edit — it never
      // calls the server itself. The one PUT .../rows call happens here,
      // after the density itself is saved, using whichever id the create/
      // update response just returned.
      if (linkRowsTouchedRef.current) {
        await api(`/api/plant-densities/${saved.density.id}/rows`, {
          method: "PUT",
          body: JSON.stringify({ rowIds: linkedRows.map((r) => r.id) }),
        });
      }
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.errors) {
        setErrors(err.errors);
      } else if (err instanceof ApiError) {
        setSubmitError(err.message);
      } else {
        setSubmitError("Something went wrong saving this density");
      }
      setSubmitting(false);
    }
  }

  // Whether Link Rows was ever opened and confirmed this session — Save
  // should only touch the row links at all if the admin actually visited
  // Link Rows; otherwise editing just the name never re-sends (and can't
  // accidentally clear) the existing row set.
  const linkRowsTouchedRef = useRef(false);

  // -- Link Rows step --------------------------------------------------

  const loadSelectionData = useCallback((landId: string) => {
    setLinkRowsError(null);
    Promise.all([
      api<{ land: GreenhouseLand }>(`/api/greenhouse-layout/lands/${landId}`),
      api<{ rows: GreenhouseRowListItem[] }>("/api/greenhouse-layout/rows?status=active"),
      api<{ links: PlantDensityRowLink[] }>(`/api/plant-densities/row-links?type=${type}`),
    ])
      .then(([landRes, rowsRes, linksRes]) => {
        setSelectionLand(buildSelectionLand(landRes.land, rowsRes.rows));
        setRowLinks(linksRes.links);
      })
      .catch((err) => setLinkRowsError(err instanceof ApiError ? err.message : "Could not load the greenhouse map"));
  }, [type]);

  function openLinkRows() {
    setDraftSelectedIds(new Set(linkedRows.map((r) => r.id)));
    setStep("linkRows");
    setLinkRowsError(null);
    if (!lands) {
      api<{ lands: GreenhouseLandListItem[] }>("/api/greenhouse-layout/lands")
        .then((res) => {
          setLands(res.lands);
          const initial = selectionLandId ?? res.lands.find((l) => l.isActive)?.id ?? res.lands[0]?.id ?? null;
          setSelectionLandId(initial);
          if (initial) loadSelectionData(initial);
        })
        .catch(() => setLinkRowsError("Could not load greenhouse lands"));
    } else if (selectionLandId) {
      loadSelectionData(selectionLandId);
    }
  }

  function handleSelectLand(landId: string) {
    setSelectionLandId(landId);
    setSelectionLand(null);
    loadSelectionData(landId);
  }

  const unavailableRowIds = new Map<string, string>();
  if (rowLinks) {
    for (const link of rowLinks) {
      if (!draftSelectedIds.has(link.greenhouseRowId)) {
        unavailableRowIds.set(link.greenhouseRowId, link.densityName);
      }
    }
  }

  // Single-row toggle — same shape as Employee Blocks' handler: deselect
  // needs no confirmation, selecting a row already owned by a *different*
  // density does.
  function toggleRow(row: LiveRow) {
    const next = new Set(draftSelectedIds);
    if (next.has(row.id)) {
      next.delete(row.id);
      setDraftSelectedIds(next);
      return;
    }
    const takenBy = unavailableRowIds.get(row.id);
    if (takenBy) {
      const proceed = window.confirm(`Row ${row.rowNumber} already belongs to "${takenBy}". Reassign it to this density?`);
      if (!proceed) return;
    }
    next.add(row.id);
    setDraftSelectedIds(next);
  }

  // Shift+click range: GreenhouseLiveCanvas has already resolved the full
  // run of rows between the last click and this one (in logical, not
  // screen, order) — add all of them at once, with a single confirmation
  // covering the whole range if any of them belong to another density,
  // rather than one popup per row.
  function handleRowClick(row: LiveRow, opts?: { shiftKey?: boolean; rangeRows?: LiveRow[] }) {
    if (opts?.rangeRows && opts.rangeRows.length > 0) {
      const newlyTaken = opts.rangeRows.filter((r) => !draftSelectedIds.has(r.id) && unavailableRowIds.has(r.id));
      if (newlyTaken.length > 0) {
        const proceed = window.confirm(
          `${newlyTaken.length} of the ${opts.rangeRows.length} rows in this range already belong to another density. Reassign all of them to this density?`
        );
        if (!proceed) return;
      }
      setDraftSelectedIds((prev) => {
        const next = new Set(prev);
        for (const r of opts.rangeRows!) next.add(r.id);
        return next;
      });
      return;
    }
    toggleRow(row);
  }

  function fitSelectionToScreen(width = viewportSize.width, height = viewportSize.height) {
    if (!selectionLand || width <= 0 || height <= 0) return;
    const fit = computeFitTransform(selectionLand, width, height);
    setFitScale(fit.scale);
    setTransform(fit);
  }

  function handleSelectionViewportSize(size: { width: number; height: number }) {
    setViewportSize(size);
    if (selectionLand && size.width > 0 && size.height > 0) {
      const fit = computeFitTransform(selectionLand, size.width, size.height);
      setFitScale(fit.scale);
      setTransform(fit);
    }
  }

  function confirmLinkRows() {
    // Fresh rowNumber/phaseName for every row visible (and possibly newly
    // selected) on the land just viewed...
    const fromCurrentLand = new Map<string, PlantDensityLinkedRow>();
    for (const phase of selectionLand?.phases ?? []) {
      for (const row of phase.rows) {
        fromCurrentLand.set(row.id, { id: row.id, rowNumber: row.rowNumber, phaseName: phase.name });
      }
    }
    // ...falling back to what was already known for a row carried over
    // from a previously-viewed land (deselecting a row is only possible
    // while its own land is the one loaded, so this never resurrects a
    // row the admin actually removed).
    const previouslyKnown = new Map(linkedRows.map((r) => [r.id, r]));
    const next = Array.from(draftSelectedIds, (id) => fromCurrentLand.get(id) ?? previouslyKnown.get(id)).filter(
      (r): r is PlantDensityLinkedRow => Boolean(r)
    );
    setLinkedRows(next);
    linkRowsTouchedRef.current = true;
    setStep("details");
  }

  function cancelLinkRows() {
    setStep("details");
  }

  const minScale = fitScale * 0.15;
  const maxScale = fitScale * 6;

  if (step === "linkRows") {
    return (
      <Modal
        title="Link Rows"
        onClose={cancelLinkRows}
        xl
        footer={
          <div className="employee-block-linkrows-footer">
            <span className="employee-block-linkrows-count">
              {draftSelectedIds.size} row{draftSelectedIds.size === 1 ? "" : "s"} selected
            </span>
            <div className="employee-form-actions">
              <button type="button" onClick={cancelLinkRows}>
                Cancel
              </button>
              <button type="button" className="employee-form-save" onClick={confirmLinkRows}>
                Confirm
              </button>
            </div>
          </div>
        }
      >
        <div className="employee-block-linkrows-toolbar">
          {lands && lands.length > 1 && (
            <label className="greenhouse-office-field">
              Land
              <span className="greenhouse-office-select-wrap">
                <select
                  className="greenhouse-office-select"
                  value={selectionLandId ?? ""}
                  onChange={(e) => handleSelectLand(e.target.value)}
                >
                  {lands.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </span>
            </label>
          )}
          <button type="button" className="greenhouse-toolbar-button" onClick={() => fitSelectionToScreen()}>
            Fit to screen
          </button>
        </div>

        {linkRowsError && <p className="error-text">{linkRowsError}</p>}

        <div className="employee-block-linkrows-canvas-wrapper">
          {selectionLand ? (
            <GreenhouseLiveCanvas
              land={selectionLand}
              phases={selectionLand.phases}
              phaseFilterId={null}
              transform={transform}
              onTransformChange={setTransform}
              onViewportSize={handleSelectionViewportSize}
              minScale={minScale}
              maxScale={maxScale}
              onRowClick={handleRowClick}
              selectedRowIds={draftSelectedIds}
              unavailableRowIds={unavailableRowIds}
            />
          ) : (
            <p className="placeholder-page">Loading map...</p>
          )}
        </div>

        <div className="greenhouse-live-legend">
          <span>
            <span className="greenhouse-live-legend-swatch greenhouse-live-row-selected" /> Selected
          </span>
          <span>
            <span className="greenhouse-live-legend-swatch greenhouse-live-row-taken" /> In another density
          </span>
          <span>
            <span className="greenhouse-live-legend-swatch greenhouse-live-row-available" /> Available
          </span>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={isEdit ? `Edit ${TYPE_LABEL[type]} Density` : `Add ${TYPE_LABEL[type]} Density`} onClose={onClose} xl>
      {loadingDetail ? (
        <p className="placeholder-page">Loading...</p>
      ) : loadError ? (
        <p className="error-text">{loadError}</p>
      ) : (
        <form onSubmit={handleSubmit} className="employee-form" noValidate>
          {submitError && <p className="error-text">{submitError}</p>}

          <section className="employee-form-section">
            <div className="employee-form-grid">
              <label>
                Density name *
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. High Density Zone 1"
                  required
                />
                {errors.name && <span className="field-error">{errors.name}</span>}
              </label>
              <label>
                {COUNT_PER_ROW_LABEL[type]} *
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={countPerRow}
                  onChange={(e) => setCountPerRow(e.target.value)}
                  required
                />
                {errors.countPerRow && <span className="field-error">{errors.countPerRow}</span>}
              </label>
            </div>
          </section>

          <section className="employee-form-section">
            <div className="employee-block-linked-rows-header">
              <h3>Linked Rows</h3>
              <span className="employees-count">
                {linkedRows.length} row{linkedRows.length === 1 ? "" : "s"}
              </span>
            </div>
            {linkedRows.length === 0 ? (
              <p className="placeholder-page">No rows linked yet.</p>
            ) : (
              <ul className="employee-block-linked-rows-list">
                {linkedRows.map((r) => (
                  <li key={r.id}>
                    Row {r.rowNumber} — {r.phaseName}
                  </li>
                ))}
              </ul>
            )}
            <button type="button" className="greenhouse-office-secondary-button" onClick={openLinkRows}>
              Link Rows
            </button>
          </section>

          <div className="employee-form-actions">
            <button type="button" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="employee-form-save" disabled={submitting}>
              {submitting ? "Saving..." : "Save"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
