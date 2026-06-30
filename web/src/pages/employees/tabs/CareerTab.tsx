import type { MockEmployee } from '../mock-data';
import { formatDate } from '../helpers';

interface Props {
  employee: MockEmployee;
}

export function CareerTab({ employee }: Props) {
  const sorted = [...employee.careerHistory].sort(
    (a, b) => new Date(b.startedOn).getTime() - new Date(a.startedOn).getTime(),
  );

  return (
    <div className="px-8 py-6">
      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
        Employment History
      </h3>

      {sorted.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center">
          <p className="text-sm text-gray-400">No employment history on record</p>
        </div>
      ) : (
        <div className="space-y-3">
          {sorted.map(record => {
            const isCurrent = !record.endedOn;
            return (
              <div key={record.id} className="bg-white rounded-lg border border-gray-200 p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-semibold text-gray-800">{record.jobRole}</span>
                      {isCurrent && (
                        <span className="text-xs bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded font-medium">
                          Current
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500">
                      {record.site} &middot; {record.contract}
                      {record.team && ` · ${record.team}`}
                    </div>
                    {record.supervisor && (
                      <div className="text-xs text-gray-400 mt-1">
                        Supervisor: {record.supervisor}
                      </div>
                    )}
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-xs font-medium text-gray-700">
                      {formatDate(record.startedOn)}
                    </div>
                    <div className="text-xs text-gray-400">
                      {isCurrent ? 'Present' : formatDate(record.endedOn!)}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
