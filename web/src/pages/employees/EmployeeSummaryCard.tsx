import type { MockEmployee, EmployeeStatus } from './mock-data';
import { getAvatarColor } from './helpers';

const STATUS_BADGE: Record<EmployeeStatus, { cls: string; label: string }> = {
  active: { cls: 'bg-emerald-100 text-emerald-700', label: 'Active' },
  inactive: { cls: 'bg-yellow-100 text-yellow-800', label: 'Inactive' },
  archived: { cls: 'bg-gray-100 text-gray-500', label: 'Archived' },
};

interface Props {
  employee: MockEmployee;
}

export function EmployeeSummaryCard({ employee }: Props) {
  const initials = `${employee.firstName[0]}${employee.lastName[0]}`;
  const avatarColor = getAvatarColor(employee.id);
  const badge = STATUS_BADGE[employee.status];

  return (
    <div className="bg-white border-b border-gray-200 px-8 py-5 flex-shrink-0">
      <div className="flex items-start gap-5">
        <div
          className={`${avatarColor} flex-shrink-0 w-14 h-14 rounded-full flex items-center justify-center text-white text-lg font-bold`}
        >
          {initials}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-xl font-semibold text-gray-900">
              {employee.firstName} {employee.lastName}
            </h1>
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${badge.cls}`}
            >
              {badge.label}
            </span>
          </div>
          <div className="text-sm text-gray-400 mt-0.5">{employee.employeeNumber}</div>

          <div className="mt-3 flex flex-wrap gap-x-8 gap-y-1">
            <SummaryField label="Contract" value={employee.contract} />
            <SummaryField label="Role" value={employee.jobRole} />
            <SummaryField label="Site" value={employee.site} />
          </div>
        </div>

        <button className="flex-shrink-0 text-sm text-gray-500 hover:text-gray-700 border border-gray-200 rounded-md px-3 py-1.5 hover:bg-gray-50 transition-colors">
          Edit
        </button>
      </div>
    </div>
  );
}

function SummaryField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-gray-400">{label}</div>
      <div className="text-sm font-medium text-gray-700">{value}</div>
    </div>
  );
}
