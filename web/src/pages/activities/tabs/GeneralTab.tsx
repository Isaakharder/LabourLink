import { useState, useEffect } from 'react';
import { Pencil, X, Check } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Activity } from '../../../api/activities';
import { activityApi } from '../../../api/activities';

interface Props {
  activity: Activity;
}

const inputCls =
  'w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500';
const selectCls =
  'w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500';

export function GeneralTab({ activity }: Props) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(toForm(activity));

  useEffect(() => {
    setForm(toForm(activity));
    setEditing(false);
  }, [activity.id]);

  const { data: options } = useQuery({
    queryKey: ['activity-form-options'],
    queryFn: activityApi.formOptions,
    enabled: editing,
  });

  const mutation = useMutation({
    mutationFn: (data: Parameters<typeof activityApi.update>[1]) =>
      activityApi.update(activity.id, data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['activities'] });
      void qc.invalidateQueries({ queryKey: ['activity', activity.id] });
      setEditing(false);
    },
  });

  function handleSave() {
    if (!form.name.trim() || !form.groupId) return;
    mutation.mutate({
      name:          form.name.trim(),
      displayName:   form.displayName || null,
      groupId:       form.groupId,
      defaultUnitId: form.defaultUnitId || null,
      icon:          form.icon || null,
      color:         form.color || null,
    });
  }

  function handleCancel() {
    setForm(toForm(activity));
    setEditing(false);
  }

  if (!editing) {
    return (
      <div className="px-8 py-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">General</h3>
          <button
            onClick={() => setEditing(true)}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 transition-colors"
          >
            <Pencil size={12} />
            Edit
          </button>
        </div>

        <Section title="Identity">
          <div className="grid grid-cols-2 gap-x-8 gap-y-5">
            <Field label="Code"         value={activity.code} mono />
            <Field label="Name"         value={activity.name} />
            <Field label="Display Name" value={activity.displayName ?? undefined} />
            <Field label="Group"        value={activity.groupName} />
          </div>
        </Section>

        <Section title="Unit &amp; Visual">
          <div className="grid grid-cols-2 gap-x-8 gap-y-5">
            <Field label="Default Unit" value={activity.defaultUnit ?? undefined} />
            <Field label="Icon"         value={activity.icon ?? undefined} mono />
            <div>
              <div className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">Color</div>
              {activity.color ? (
                <div className="flex items-center gap-2">
                  <span
                    className="w-5 h-5 rounded border border-black/10 flex-shrink-0"
                    style={{ backgroundColor: activity.color }}
                  />
                  <span className="text-sm font-mono text-gray-800">{activity.color}</span>
                </div>
              ) : (
                <span className="text-sm text-gray-400 italic">—</span>
              )}
            </div>
          </div>
        </Section>
      </div>
    );
  }

  // Edit mode
  return (
    <div className="px-8 py-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">General</h3>
        <button onClick={handleCancel} className="text-gray-400 hover:text-gray-600 transition-colors">
          <X size={15} />
        </button>
      </div>

      <Section title="Identity">
        <div className="grid grid-cols-2 gap-4">
          {/* Code — read-only, immutable after creation */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Code</label>
            <div className="px-3 py-2 text-sm font-mono text-gray-600 bg-gray-50 border border-gray-200 rounded-md">
              {form.code}
            </div>
            <p className="mt-1 text-xs text-gray-400">Set at creation, cannot be changed</p>
          </div>

          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              className={inputCls}
              placeholder="Harvest"
            />
          </div>

          {/* Display Name */}
          <div className="col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">Display Name</label>
            <input
              type="text"
              value={form.displayName}
              onChange={e => setForm(f => ({ ...f, displayName: e.target.value }))}
              className={inputCls}
              placeholder="Same as name if empty"
            />
          </div>

          {/* Group */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Group <span className="text-red-500">*</span>
            </label>
            <select
              value={form.groupId}
              onChange={e => setForm(f => ({ ...f, groupId: parseInt(e.target.value, 10) }))}
              className={selectCls}
            >
              {options?.groups.map(g => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </div>

          {/* Default Unit */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Default Unit</label>
            <select
              value={form.defaultUnitId ?? ''}
              onChange={e => setForm(f => ({ ...f, defaultUnitId: e.target.value ? parseInt(e.target.value, 10) : null }))}
              className={selectCls}
            >
              <option value="">None</option>
              {options?.units.map(u => (
                <option key={u.id} value={u.id}>{u.name} ({u.code})</option>
              ))}
            </select>
          </div>
        </div>
      </Section>

      <Section title="Unit &amp; Visual">
        <div className="grid grid-cols-2 gap-4">
          {/* Icon */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Icon</label>
            <input
              type="text"
              value={form.icon}
              onChange={e => setForm(f => ({ ...f, icon: e.target.value }))}
              className={`${inputCls} font-mono`}
              placeholder="scissors"
            />
            <p className="mt-1 text-xs text-gray-400">Lucide icon name</p>
          </div>

          {/* Color */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Color</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={form.color || '#6366F1'}
                onChange={e => setForm(f => ({ ...f, color: e.target.value }))}
                className="w-9 h-9 rounded border border-gray-200 cursor-pointer p-0.5 flex-shrink-0"
              />
              <input
                type="text"
                value={form.color}
                onChange={e => setForm(f => ({ ...f, color: e.target.value }))}
                className={`${inputCls} font-mono`}
                placeholder="#10B981"
                maxLength={7}
              />
            </div>
          </div>
        </div>
      </Section>

      {mutation.isError && (
        <p className="mb-4 text-sm text-red-600">
          {mutation.error instanceof Error ? mutation.error.message : 'Failed to save. Please try again.'}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={mutation.isPending || !form.name.trim()}
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
  );
}

function toForm(a: Activity) {
  return {
    code:          a.code,
    name:          a.name,
    displayName:   a.displayName ?? '',
    groupId:       a.groupId,
    defaultUnitId: a.defaultUnitId,
    icon:          a.icon ?? '',
    color:         a.color ?? '',
  };
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">{title}</h4>
      <div className="bg-white rounded-lg border border-gray-200 p-5">{children}</div>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value?: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-sm text-gray-800 ${mono ? 'font-mono' : ''}`}>
        {value ? value : <span className="text-gray-400 italic">—</span>}
      </div>
    </div>
  );
}
