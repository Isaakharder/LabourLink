import type { MockEmployee, TimelineEvent } from '../mock-data';
import { formatDate } from '../helpers';

interface Props {
  employee: MockEmployee;
}

const EVENT_CONFIG: Record<TimelineEvent['type'], { dot: string; label: string }> = {
  employment: { dot: 'bg-blue-500', label: 'Employment' },
  contract: { dot: 'bg-purple-500', label: 'Contract' },
  security: { dot: 'bg-amber-500', label: 'Security' },
  device: { dot: 'bg-teal-500', label: 'Device' },
  archive: { dot: 'bg-gray-400', label: 'Archive' },
  note: { dot: 'bg-gray-300', label: 'Note' },
};

export function TimelineTab({ employee }: Props) {
  const sorted = [...employee.timeline].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );

  return (
    <div className="px-8 py-6">
      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
        Activity Timeline
      </h3>

      {sorted.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center">
          <p className="text-sm text-gray-400">No timeline events</p>
        </div>
      ) : (
        <div className="relative">
          <div className="absolute left-4 top-4 bottom-4 w-px bg-gray-200" />

          <div className="space-y-3">
            {sorted.map(event => {
              const config = EVENT_CONFIG[event.type];
              return (
                <div key={event.id} className="flex items-start gap-3">
                  <div className="w-8 flex-shrink-0 flex justify-center pt-[18px]">
                    <div
                      className={`relative z-10 w-3 h-3 rounded-full ${config.dot} ring-2 ring-white`}
                    />
                  </div>
                  <div className="flex-1 bg-white rounded-lg border border-gray-200 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                          {config.label}
                        </span>
                        <span className="text-xs text-gray-300 mx-1.5">&middot;</span>
                        <span className="text-sm text-gray-700">{event.description}</span>
                      </div>
                      <div className="text-xs text-gray-400 flex-shrink-0 mt-0.5">
                        {formatDate(event.date)}
                      </div>
                    </div>
                    {event.performedBy && (
                      <div className="mt-1 text-xs text-gray-400">By {event.performedBy}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
