import { BreakProfile } from "../../lib/breakProfileTypes";

type StatusFilter = "active" | "inactive" | "all";

interface BreakProfileListPanelProps {
  profiles: BreakProfile[] | null;
  error: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
  status: StatusFilter;
  onStatusChange: (value: StatusFilter) => void;
  onAddNew: () => void;
}

export function BreakProfileListPanel({
  profiles,
  error,
  selectedId,
  onSelect,
  search,
  onSearchChange,
  status,
  onStatusChange,
  onAddNew,
}: BreakProfileListPanelProps) {
  return (
    <div className="break-profiles-list-panel">
      <input
        type="search"
        placeholder="Search break profiles"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        className="break-profiles-search"
      />

      <select value={status} onChange={(e) => onStatusChange(e.target.value as StatusFilter)}>
        <option value="active">Active</option>
        <option value="inactive">Inactive</option>
        <option value="all">All</option>
      </select>

      <button type="button" className="employees-add-button" onClick={onAddNew}>
        Add Break Profile
      </button>

      {error ? (
        <p className="error-text">{error}</p>
      ) : !profiles ? (
        <p>Loading...</p>
      ) : profiles.length === 0 ? (
        <p className="placeholder-page">No break profiles match these filters.</p>
      ) : (
        <ul className="break-profiles-list">
          {profiles.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className={`break-profiles-item${p.id === selectedId ? " break-profiles-item-selected" : ""}`}
                onClick={() => onSelect(p.id)}
              >
                <span className="break-profiles-item-name">{p.name}</span>
                <span className={`status-pill ${p.isActive ? "status-active" : "status-inactive"}`}>
                  {p.isActive ? "Active" : "Inactive"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
