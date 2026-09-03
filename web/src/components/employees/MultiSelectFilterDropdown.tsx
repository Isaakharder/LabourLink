import { useEffect, useMemo, useRef, useState } from "react";

export interface MultiSelectFilterOption {
  value: string;
  label: string;
}

interface MultiSelectFilterDropdownProps {
  label: string;
  options: MultiSelectFilterOption[];
  selected: string[]; // empty = "All"
  onChange: (next: string[]) => void;
  searchable?: boolean;
}

// Generic multi-select filter — the same trigger + anchored staged-panel
// shape as reports/ReportEmployeeSelectDropdown.tsx (All/Select all/Clear,
// a checkbox list, discard-on-cancel/outside-click/Escape), but applied
// directly to a client-only filter (no server round trip — Employment
// Timeline filters are transient view state, not a persisted report
// definition the way ReportEmployeeSelectDropdown's selection is).
export function MultiSelectFilterDropdown({ label, options, selected, onChange, searchable = false }: MultiSelectFilterDropdownProps) {
  const [open, setOpen] = useState(false);
  const [staged, setStaged] = useState<Set<string>>(new Set(selected));
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  function openPanel() {
    setStaged(new Set(selected));
    setSearch("");
    setOpen(true);
  }

  function cancel() {
    setOpen(false);
  }

  function apply() {
    onChange([...staged]);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") cancel();
    }
    function onMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) cancel();
    }
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const searchTerm = search.trim().toLowerCase();
  const visibleOptions = useMemo(
    () => (searchTerm ? options.filter((o) => o.label.toLowerCase().includes(searchTerm)) : options),
    [options, searchTerm]
  );

  function toggle(value: string) {
    setStaged((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  function selectAllVisible() {
    setStaged((prev) => new Set([...prev, ...visibleOptions.map((o) => o.value)]));
  }

  function clearAll() {
    setStaged(new Set());
  }

  const triggerLabel = selected.length === 0 ? `${label}: All` : `${label}: ${selected.length} selected`;

  return (
    <div className="employment-timeline-filter" ref={rootRef}>
      <button type="button" className="employment-timeline-filter-trigger" onClick={() => (open ? cancel() : openPanel())} aria-expanded={open}>
        {triggerLabel} <span aria-hidden="true">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="employment-timeline-filter-panel" role="dialog" aria-label={`Filter by ${label}`}>
          {searchable && (
            <input
              type="text"
              className="employment-timeline-filter-search"
              placeholder={`Search ${label.toLowerCase()}...`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          )}

          <div className="employment-timeline-filter-toolbar">
            <button type="button" onClick={() => setStaged(new Set())}>
              All
            </button>
            <button type="button" onClick={selectAllVisible} disabled={visibleOptions.length === 0}>
              Select all
            </button>
            <button type="button" onClick={clearAll} disabled={staged.size === 0}>
              Clear all
            </button>
          </div>

          <div className="employment-timeline-filter-list">
            {visibleOptions.length === 0 ? (
              <p className="placeholder-page">No options match.</p>
            ) : (
              visibleOptions.map((o) => (
                <label key={o.value} className="employment-timeline-filter-item">
                  <input type="checkbox" checked={staged.has(o.value)} onChange={() => toggle(o.value)} />
                  <span>{o.label}</span>
                </label>
              ))
            )}
          </div>

          <div className="employment-timeline-filter-footer">
            <button type="button" onClick={cancel}>
              Cancel
            </button>
            <button type="button" className="employment-timeline-filter-apply" onClick={apply}>
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
