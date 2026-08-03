import { GreenhousePhase } from "../../lib/greenhouseLayoutTypes";

interface PhaseListProps {
  phases: GreenhousePhase[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function PhaseList({ phases, selectedId, onSelect }: PhaseListProps) {
  if (phases.length === 0) {
    return <p className="placeholder-page">No phases yet — use Create Phase to add one.</p>;
  }

  return (
    <ul className="greenhouse-phase-list">
      {phases.map((p) => (
        <li key={p.id}>
          <button
            type="button"
            className={`greenhouse-phase-item${p.id === selectedId ? " greenhouse-phase-item-selected" : ""}${
              p.isActive ? "" : " greenhouse-phase-item-inactive"
            }`}
            onClick={() => onSelect(p.id)}
          >
            <span className="greenhouse-phase-item-name">{p.name}</span>
            <span className="greenhouse-phase-item-dims">
              {p.eastWestFeet} ft × {p.northSouthFeet} ft
            </span>
            <span className={`status-pill ${p.isActive ? "status-active" : "status-inactive"}`}>
              {p.isActive ? "Active" : "Inactive"}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
