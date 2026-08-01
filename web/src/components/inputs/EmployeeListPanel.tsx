import { Avatar } from "../employees/Avatar";
import { InputsEmployee } from "../../lib/inputsTypes";

interface EmployeeListPanelProps {
  employees: InputsEmployee[] | null;
  error: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
}

export function EmployeeListPanel({
  employees,
  error,
  selectedId,
  onSelect,
  search,
  onSearchChange,
}: EmployeeListPanelProps) {
  return (
    <div className="inputs-employee-panel">
      <input
        type="search"
        placeholder="Search employees"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        className="inputs-employee-search"
      />
      {error ? (
        <p className="error-text">{error}</p>
      ) : !employees ? (
        <p>Loading...</p>
      ) : employees.length === 0 ? (
        <p className="placeholder-page">No active employees found.</p>
      ) : (
        <ul className="inputs-employee-list">
          {employees.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                className={`inputs-employee-item${e.id === selectedId ? " inputs-employee-item-selected" : ""}`}
                onClick={() => onSelect(e.id)}
              >
                <Avatar photoUrl={e.photoUrl} firstName={e.firstName} lastName={e.lastName} />
                <span className="inputs-employee-name">
                  {e.firstName} {e.lastName}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
