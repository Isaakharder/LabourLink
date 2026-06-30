import { useState } from 'react';
import { Search, UserPlus } from 'lucide-react';
import type { MockEmployee, EmployeeStatus } from './mock-data';
import { getAvatarColor } from './helpers';

const STATUS_DOT: Record<EmployeeStatus, string> = {
  active: 'bg-emerald-500',
  inactive: 'bg-yellow-400',
  archived: 'bg-gray-300',
};

interface Props {
  employees: MockEmployee[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onNew: () => void;
}

export function EmployeeList({ employees, selectedId, onSelect, onNew }: Props) {
  const [search, setSearch] = useState('');

  const filtered = employees.filter(e => {
    const q = search.toLowerCase();
    return (
      e.firstName.toLowerCase().includes(q) ||
      e.lastName.toLowerCase().includes(q) ||
      e.employeeNumber.toLowerCase().includes(q)
    );
  });

  return (
    <aside className="w-72 flex-shrink-0 flex flex-col border-r border-gray-200 bg-white">
      <div className="px-4 pt-5 pb-3 border-b border-gray-200">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
            Employees
          </h2>
          <button
            onClick={onNew}
            className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 hover:text-emerald-800 transition-colors"
          >
            <UserPlus size={13} />
            New
          </button>
        </div>
        <div className="relative">
          <Search
            size={13}
            className="absolute left-2.5 top-2.5 text-gray-400 pointer-events-none"
          />
          <input
            type="text"
            placeholder="Search..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-2 text-sm border border-gray-200 rounded-md bg-gray-50 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500"
          />
        </div>
      </div>

      <ul className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <li className="px-4 py-8 text-center text-sm text-gray-400">No employees found</li>
        ) : (
          filtered.map(emp => {
            const isSelected = emp.id === selectedId;
            const initials = `${emp.firstName[0]}${emp.lastName[0]}`;
            const avatarColor = getAvatarColor(emp.id);

            return (
              <li key={emp.id}>
                <button
                  onClick={() => onSelect(emp.id)}
                  className={`w-full text-left px-4 py-3 flex items-center gap-3 border-l-2 transition-colors ${
                    isSelected
                      ? 'border-l-emerald-600 bg-emerald-50'
                      : 'border-l-transparent hover:bg-gray-50'
                  }`}
                >
                  <div
                    className={`${avatarColor} flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-semibold`}
                  >
                    {initials}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-sm font-medium truncate ${
                          isSelected ? 'text-emerald-900' : 'text-gray-800'
                        }`}
                      >
                        {emp.firstName} {emp.lastName}
                      </span>
                      <span
                        className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_DOT[emp.status]}`}
                      />
                    </div>
                    <div className="text-xs text-gray-400 mt-0.5">{emp.employeeNumber}</div>
                  </div>
                </button>
              </li>
            );
          })
        )}
      </ul>

      <div className="px-4 py-2 border-t border-gray-100 text-xs text-gray-400">
        {filtered.length} of {employees.length}
      </div>
    </aside>
  );
}
