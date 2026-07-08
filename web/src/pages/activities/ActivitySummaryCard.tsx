import * as LucideIcons from 'lucide-react';
import type { LucideProps } from 'lucide-react';
import type { Activity } from '../../api/activities';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { activityApi } from '../../api/activities';

interface Props {
  activity: Activity;
}

export function ActivitySummaryCard({ activity }: Props) {
  const qc = useQueryClient();

  const archiveMutation = useMutation({
    mutationFn: () =>
      activityApi.update(activity.id, {
        archivedAt: activity.archivedAt ? null : new Date().toISOString(),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['activities'] });
      void qc.invalidateQueries({ queryKey: ['activity', activity.id] });
    },
  });

  const isArchived = activity.archivedAt !== null;

  return (
    <div className="bg-white border-b border-gray-200 px-8 py-5 flex-shrink-0">
      <div className="flex items-start gap-5">
        {/* Color/icon avatar */}
        <div
          className="flex-shrink-0 w-14 h-14 rounded-xl flex items-center justify-center"
          style={{ backgroundColor: activity.color ?? '#9CA3AF' }}
        >
          <ActivityIcon name={activity.icon} size={26} className="text-white" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-xl font-semibold text-gray-900">
              {activity.displayName ?? activity.name}
            </h1>
            {isArchived ? (
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-500">
                Archived
              </span>
            ) : (
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-700">
                Active
              </span>
            )}
          </div>

          <div className="text-sm font-mono text-gray-400 mt-0.5">{activity.code}</div>

          <div className="mt-3 flex flex-wrap gap-x-8 gap-y-1">
            <SummaryField label="Group"        value={activity.groupName} />
            <SummaryField label="Default Unit" value={activity.defaultUnit} />
          </div>
        </div>

        <button
          onClick={() => archiveMutation.mutate()}
          disabled={archiveMutation.isPending}
          className="flex-shrink-0 text-sm text-gray-500 hover:text-gray-700 border border-gray-200 rounded-md px-3 py-1.5 hover:bg-gray-50 transition-colors disabled:opacity-50"
        >
          {isArchived ? 'Restore' : 'Archive'}
        </button>
      </div>
    </div>
  );
}

function SummaryField({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <div className="text-xs text-gray-400">{label}</div>
      <div className="text-sm font-medium text-gray-700">{value ?? '—'}</div>
    </div>
  );
}

function ActivityIcon({
  name,
  size,
  className,
}: {
  name: string | null;
  size?: number;
  className?: string;
}) {
  if (!name) return null;
  const pascal = name.replace(/(^|[-_])([a-z])/g, (_, __, c: string) => c.toUpperCase());
  const Icon = (LucideIcons as Record<string, React.ComponentType<LucideProps>>)[pascal];
  if (!Icon) return null;
  return <Icon size={size} className={className} />;
}
