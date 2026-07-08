import { useState, useEffect } from 'react';
import { Pencil, X, Check } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Activity } from '../../../api/activities';
import { activityApi } from '../../../api/activities';

interface Props {
  activity: Activity;
}

export function MobileTab({ activity }: Props) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [visibleOnMobile, setVisibleOnMobile] = useState(activity.visibleOnMobile);
  const [sortOrder, setSortOrder] = useState(String(activity.sortOrder));

  useEffect(() => {
    setVisibleOnMobile(activity.visibleOnMobile);
    setSortOrder(String(activity.sortOrder));
    setEditing(false);
  }, [activity.id]);

  const mutation = useMutation({
    mutationFn: () =>
      activityApi.update(activity.id, {
        visibleOnMobile,
        sortOrder: parseInt(sortOrder, 10) || 0,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['activities'] });
      void qc.invalidateQueries({ queryKey: ['activity', activity.id] });
      setEditing(false);
    },
  });

  function handleCancel() {
    setVisibleOnMobile(activity.visibleOnMobile);
    setSortOrder(String(activity.sortOrder));
    setEditing(false);
  }

  return (
    <div className="px-8 py-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Mobile Settings</h3>
        {!editing ? (
          <button
            onClick={() => setEditing(true)}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 transition-colors"
          >
            <Pencil size={12} />
            Edit
          </button>
        ) : (
          <button onClick={handleCancel} className="text-gray-400 hover:text-gray-600 transition-colors">
            <X size={15} />
          </button>
        )}
      </div>

      <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
        {/* Visible on mobile */}
        <div className="flex items-start gap-4 px-5 py-4">
          <div className="flex-1">
            <div className="text-sm font-medium text-gray-800">Visible on Mobile</div>
            <div className="text-xs text-gray-500 mt-0.5">
              When off, this activity does not appear in the employee&apos;s activity picker.
              Supervisors and managers can still assign it manually.
            </div>
          </div>
          {editing ? (
            <Toggle value={visibleOnMobile} onChange={setVisibleOnMobile} />
          ) : (
            <span
              className={`flex-shrink-0 text-xs font-medium px-2 py-0.5 rounded ${
                activity.visibleOnMobile
                  ? 'bg-emerald-100 text-emerald-700'
                  : 'bg-gray-100 text-gray-500'
              }`}
            >
              {activity.visibleOnMobile ? 'Visible' : 'Hidden'}
            </span>
          )}
        </div>

        {/* Sort order */}
        <div className="flex items-start gap-4 px-5 py-4">
          <div className="flex-1">
            <div className="text-sm font-medium text-gray-800">Sort Order</div>
            <div className="text-xs text-gray-500 mt-0.5">
              Controls the display position within the activity group in the mobile picker.
              Lower numbers appear first.
            </div>
          </div>
          {editing ? (
            <input
              type="number"
              min={0}
              value={sortOrder}
              onChange={e => setSortOrder(e.target.value)}
              className="w-20 px-3 py-1.5 text-sm border border-gray-200 rounded-md bg-white text-right focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500"
            />
          ) : (
            <span className="flex-shrink-0 text-sm font-mono text-gray-700">{activity.sortOrder}</span>
          )}
        </div>
      </div>

      {editing && (
        <div className="mt-6">
          {mutation.isError && (
            <p className="mb-4 text-sm text-red-600">
              {mutation.error instanceof Error ? mutation.error.message : 'Failed to save. Please try again.'}
            </p>
          )}
          <div className="flex items-center gap-3">
            <button
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
              className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Check size={14} />
              {mutation.isPending ? 'Saving…' : 'Save Changes'}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className={`relative flex-shrink-0 w-10 h-5 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-1 ${
        value ? 'bg-emerald-500' : 'bg-gray-200'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
          value ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  );
}
