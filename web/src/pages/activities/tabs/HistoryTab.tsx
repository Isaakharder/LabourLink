import { Clock } from 'lucide-react';
import type { Activity } from '../../../api/activities';

interface Props {
  activity: Activity;
}

export function HistoryTab({ activity }: Props) {
  return (
    <div className="px-8 py-6">
      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-6">History</h3>

      <div className="bg-white rounded-lg border border-gray-200 p-5 mb-6">
        <div className="grid grid-cols-2 gap-x-8 gap-y-5">
          <MetaField label="Created" value={formatDateTime(activity.createdAt)} />
          <MetaField label="Last Updated" value={formatDateTime(activity.updatedAt)} />
        </div>
      </div>

      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Clock size={36} className="text-gray-200 mb-3" />
        <p className="text-sm font-medium text-gray-500">Work registration history not yet available</p>
        <p className="text-xs text-gray-400 mt-1 max-w-xs">
          When employees register work against this activity, a timeline of
          registrations will appear here.
        </p>
      </div>
    </div>
  );
}

function MetaField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">{label}</div>
      <div className="text-sm text-gray-800">{value}</div>
    </div>
  );
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
