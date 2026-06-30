import type { Employee } from '../../../api/employees';

interface Props {
  employee: Employee;
}

export function NotesTab({ employee }: Props) {
  return (
    <div className="px-8 py-6">
      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">Notes</h3>
      <div className="bg-white rounded-lg border border-gray-200 p-5 min-h-32">
        {employee.notes ? (
          <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
            {employee.notes}
          </p>
        ) : (
          <p className="text-sm text-gray-400 italic">No notes for this employee.</p>
        )}
      </div>
    </div>
  );
}
