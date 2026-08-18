import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "../ui/Modal";
import { GreenhouseLiveCanvas } from "../greenhouseLive/GreenhouseLiveCanvas";
import { api, ApiError } from "../../lib/api";
import { CanvasTransform, computeFitTransform } from "../../lib/canvasTransform";
import { EmployeeBlockDetail, EmployeeBlockLinkedRow, EmployeeBlockRowLink } from "../../lib/employeeBlockTypes";
import { GreenhouseLandListItem, GreenhouseLand, GreenhouseRowListItem } from "../../lib/greenhouseLayoutTypes";
import { LiveLand, LiveRow } from "../../lib/greenhouseLiveTypes";
import { EMPLOYEE_BLOCK_COLOR_KEYS, EMPLOYEE_BLOCK_COLORS, EmployeeBlockColorKey } from "../../lib/employeeBlockColors";
import { useAuth } from "../../context/AuthContext";

interface EmployeeBlockFormModalProps {
  blockId: string | null; // null = create mode
  onClose: () => void;
  onSaved: () => void;
}

interface EmployeeOption {
  id: string;
  firstName: string;
  lastName: string;
}

type Step = "details" | "linkRows";

// Merges the layout editor's own land-detail (phase geometry) and flat
// active-rows list — both already-existing endpoints — into the same
// LiveLand shape GreenhouseLiveCanvas already renders, so nothing about
// the canvas itself needs to know this data didn't come from the live
// endpoint. state/employees are placeholders selection mode never reads
// (see GreenhouseLiveCanvas's onRowClick branch).
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

export function EmployeeBlockFormModal({ blockId, onClose, onSaved }: EmployeeBlockFormModalProps) {
  const { employee: actor } = useAuth();
  // A Manager may only change a block's colour (server-enforced too — see
  // PATCH /api/employee-blocks/:id's own isAdministrator check); name,
  // assigned employee, and row links stay Administrator-only.
  const canEditNameAndRows = actor?.securityRole === "Administrator";

  const isEdit = Boolean(blockId);
  const [step, setStep] = useState<Step>("details");

  const [loadingDetail, setLoadingDetail] = useState(isEdit);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [linkedRows, setLinkedRows] = useState<EmployeeBlockLinkedRow[]>([]);
  // null on create = "let the server auto-assign the least-used preset" —
  // only set here once the admin explicitly picks a swatch, or once an
  // existing block's own saved colour has loaded.
  const [colorKey, setColorKey] = useState<EmployeeBlockColorKey | null>(null);

  const [employees, setEmployees] = useState<EmployeeOption[] | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // -- Link Rows step state --
  const [lands, setLands] = useState<GreenhouseLandListItem[] | null>(null);
  const [selectionLandId, setSelectionLandId] = useState<string | null>(null);
  const [selectionLand, setSelectionLand] = useState<LiveLand | null>(null);
  const [rowLinks, setRowLinks] = useState<EmployeeBlockRowLink[] | null>(null);
  const [draftSelectedIds, setDraftSelectedIds] = useState<Set<string>>(new Set());
  const [linkRowsError, setLinkRowsError] = useState<string | null>(null);
  const [transform, setTransform] = useState<CanvasTransform>({ pan: { x: 0, y: 0 }, scale: 1 });
  const [fitScale, setFitScale] = useState(1);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    api<{ employees: EmployeeOption[] }>("/api/employees?status=active")
      .then((res) => setEmployees(res.employees))
      .catch(() => setEmployees([]));
  }, []);

  useEffect(() => {
    if (!blockId) return;
    api<{ block: EmployeeBlockDetail }>(`/api/employee-blocks/${blockId}`)
      .then((res) => {
        setName(res.block.name);
        setEmployeeId(res.block.employeeId);
        setLinkedRows(res.block.rows);
        setColorKey(res.block.colorKey as EmployeeBlockColorKey);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Could not load this block"))
      .finally(() => setLoadingDetail(false));
  }, [blockId]);

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "Block name is required";
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
      // A Manager's payload only ever carries colorKey (the fields they
      // can't edit are disabled in the form below anyway, but this also
      // keeps the actual request honest about what changed, matching the
      // server's own isAdministrator-gated field check).
      const payload = canEditNameAndRows
        ? { name: name.trim(), employeeId, ...(colorKey ? { colorKey } : {}) }
        : { ...(colorKey ? { colorKey } : {}) };
      const saved = isEdit
        ? await api<{ block: EmployeeBlockDetail }>(`/api/employee-blocks/${blockId}`, {
            method: "PATCH",
            body: JSON.stringify(payload),
          })
        : await api<{ block: EmployeeBlockDetail }>("/api/employee-blocks", {
            method: "POST",
            body: JSON.stringify(payload),
          });

      // Linking rows (openLinkRows/confirmLinkRows below) is a purely
      // local draft operation regardless of create vs. edit — it never
      // calls the server itself. The one PUT .../rows call happens here,
      // after the block itself is saved, using whichever id the create/
      // update response just returned (so a brand-new block's just-linked
      // rows are attached in the same Save click, not a second step).
      if (linkRowsTouchedRef.current) {
        await api(`/api/employee-blocks/${saved.block.id}/rows`, {
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
        setSubmitError("Something went wrong saving this block");
      }
      setSubmitting(false);
    }
  }

  // Whether Link Rows was ever opened and confirmed this session — Save
  // should only touch the row links at all if the admin actually visited
  // Link Rows; otherwise editing just the name/employee never re-sends
  // (and can't accidentally clear) the existing row set.
  const linkRowsTouchedRef = useRef(false);

  // -- Link Rows step --------------------------------------------------

  const loadSelectionData = useCallback((landId: string) => {
    setLinkRowsError(null);
    Promise.all([
      api<{ land: GreenhouseLand }>(`/api/greenhouse-layout/lands/${landId}`),
      api<{ rows: GreenhouseRowListItem[] }>("/api/greenhouse-layout/rows?status=active"),
      api<{ links: EmployeeBlockRowLink[] }>("/api/employee-blocks/row-links"),
    ])
      .then(([landRes, rowsRes, linksRes]) => {
        setSelectionLand(buildSelectionLand(landRes.land, rowsRes.rows));
        setRowLinks(linksRes.links);
      })
      .catch((err) => setLinkRowsError(err instanceof ApiError ? err.message : "Could not load the greenhouse map"));
  }, []);

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
        unavailableRowIds.set(link.greenhouseRowId, link.blockName);
      }
    }
  }

  function handleRowClick(row: LiveRow) {
    const next = new Set(draftSelectedIds);
    if (next.has(row.id)) {
      next.delete(row.id);
      setDraftSelectedIds(next);
      return;
    }
    const takenBy = unavailableRowIds.get(row.id);
    if (takenBy) {
      const proceed = window.confirm(`Row ${row.rowNumber} already belongs to "${takenBy}". Reassign it to this block?`);
      if (!proceed) return;
    }
    next.add(row.id);
    setDraftSelectedIds(next);
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
    const fromCurrentLand = new Map<string, EmployeeBlockLinkedRow>();
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
      (r): r is EmployeeBlockLinkedRow => Boolean(r)
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
            <span className="greenhouse-live-legend-swatch greenhouse-live-row-taken" /> In another block
          </span>
          <span>
            <span className="greenhouse-live-legend-swatch greenhouse-live-row-available" /> Available
          </span>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={isEdit ? "Edit Block" : "Add Block"} onClose={onClose} xl>
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
                Block name *
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Lester's Block"
                  required
                  disabled={!canEditNameAndRows}
                />
                {errors.name && <span className="field-error">{errors.name}</span>}
              </label>
              <label>
                Assigned employee
                <span className="greenhouse-office-select-wrap">
                  <select
                    className="greenhouse-office-select"
                    value={employeeId ?? ""}
                    onChange={(e) => setEmployeeId(e.target.value || null)}
                    disabled={!employees || !canEditNameAndRows}
                  >
                    <option value="">Unassigned</option>
                    {employees?.map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {emp.firstName} {emp.lastName}
                      </option>
                    ))}
                  </select>
                </span>
                {errors.employeeId && <span className="field-error">{errors.employeeId}</span>}
              </label>
            </div>
            {!canEditNameAndRows && (
              <p className="field-hint">As a Manager, you can change this block's colour below — name, assigned employee, and linked rows are Administrator-only.</p>
            )}
          </section>

          <section className="employee-form-section">
            <span className="employee-form-grid-label">Block colour</span>
            <div className="employee-block-color-swatches" role="group" aria-label="Block colour">
              {EMPLOYEE_BLOCK_COLOR_KEYS.map((key) => {
                const def = EMPLOYEE_BLOCK_COLORS[key];
                const isSelected = colorKey === key;
                return (
                  <button
                    key={key}
                    type="button"
                    className={`employee-block-color-swatch${isSelected ? " employee-block-color-swatch-selected" : ""}`}
                    style={{ background: def.fill, borderColor: def.stroke }}
                    aria-pressed={isSelected}
                    title={def.label}
                    onClick={() => setColorKey(key)}
                  >
                    <span className="sr-only">{def.label}</span>
                  </button>
                );
              })}
            </div>
            {errors.colorKey && <span className="field-error">{errors.colorKey}</span>}
            <div className="employee-block-color-preview">
              <span
                className="employee-block-color-preview-swatch"
                style={
                  colorKey
                    ? { background: EMPLOYEE_BLOCK_COLORS[colorKey].fill, borderColor: EMPLOYEE_BLOCK_COLORS[colorKey].stroke }
                    : undefined
                }
              />
              <span>
                {colorKey
                  ? `Preview: ${name.trim() || "This block"} will show as ${EMPLOYEE_BLOCK_COLORS[colorKey].label.toLowerCase()} on the live map.`
                  : "A soft colour not already heavily used will be assigned automatically, or pick one above."}
              </span>
            </div>
          </section>

          {canEditNameAndRows && (
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
          )}

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
