import { useState } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { activityApi } from '../../api/activities';

const inputCls =
  'w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500';
const selectCls =
  'w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500';

interface Props {
  onCancel: () => void;
  onCreated: (id: number) => void;
}

export function NewActivityForm({ onCancel, onCreated }: Props) {
  const [name,            setName]            = useState('');
  const [displayName,     setDisplayName]     = useState('');
  const [groupId,         setGroupId]         = useState('');
  const [defaultUnitId,   setDefaultUnitId]   = useState('');
  const [icon,            setIcon]            = useState('');
  const [color,           setColor]           = useState('#6366F1');
  const [visibleOnMobile, setVisibleOnMobile] = useState(true);

  const { data: options, isLoading: optionsLoading } = useQuery({
    queryKey: ['activity-form-options'],
    queryFn: activityApi.formOptions,
  });

  const mutation = useMutation({
    mutationFn: activityApi.create,
    onSuccess: ({ id }) => onCreated(id),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !groupId) return;

    mutation.mutate({
      name: name.trim(),
      displayName:   displayName   || undefined,
      groupId:       parseInt(groupId, 10),
      defaultUnitId: defaultUnitId ? parseInt(defaultUnitId, 10) : undefined,
      icon:          icon          || undefined,
      color:         color         || undefined,
      visibleOnMobile,
    });
  }

  const canSubmit = !!name.trim() && !!groupId && !mutation.isPending;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-8 py-5 flex-shrink-0 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">New Activity</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            Define a new work activity that employees can register against.
          </p>
        </div>
        <button
          onClick={onCancel}
          aria-label="Cancel"
          className="text-gray-400 hover:text-gray-600 transition-colors"
        >
          <X size={20} />
        </button>
      </div>

      {/* Form */}
      <div className="flex-1 overflow-y-auto bg-gray-50 px-8 py-6">
        <form onSubmit={handleSubmit} className="max-w-lg space-y-6">

          {/* Identity */}
          <section>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
              Identity
            </h3>
            <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">

              {/* Name */}
              <FormField label="Activity Name" required>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  className={inputCls}
                  placeholder="e.g. Picking Peppers"
                  autoFocus
                  required
                />
                <p className="mt-1 text-xs text-gray-400">Activity code is generated automatically.</p>
              </FormField>

              {/* Display name */}
              <FormField label="Display Name">
                <input
                  type="text"
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  className={inputCls}
                  placeholder="Shown to employees — defaults to Name"
                />
              </FormField>

              {/* Group */}
              <FormField label="Activity Group" required>
                <select
                  value={groupId}
                  onChange={e => setGroupId(e.target.value)}
                  className={selectCls}
                  required
                  disabled={optionsLoading}
                >
                  <option value="">Select group…</option>
                  {options?.groups.map(g => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
              </FormField>

              {/* Default unit */}
              <FormField label="Default Unit">
                <select
                  value={defaultUnitId}
                  onChange={e => setDefaultUnitId(e.target.value)}
                  className={selectCls}
                  disabled={optionsLoading}
                >
                  <option value="">None</option>
                  {options?.units.map(u => (
                    <option key={u.id} value={u.id}>{u.name} ({u.code})</option>
                  ))}
                </select>
              </FormField>
            </div>
          </section>

          {/* Visual */}
          <section>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
              Visual
            </h3>
            <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
              <FormField label="Icon">
                <input
                  type="text"
                  value={icon}
                  onChange={e => setIcon(e.target.value)}
                  className={`${inputCls} font-mono`}
                  placeholder="scissors"
                />
                <p className="mt-1 text-xs text-gray-400">Lucide icon name</p>
              </FormField>

              <FormField label="Color">
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={color}
                    onChange={e => setColor(e.target.value)}
                    className="w-9 h-9 rounded border border-gray-200 cursor-pointer p-0.5 flex-shrink-0"
                  />
                  <input
                    type="text"
                    value={color}
                    onChange={e => setColor(e.target.value)}
                    className={`${inputCls} font-mono`}
                    placeholder="#10B981"
                    maxLength={7}
                  />
                </div>
              </FormField>
            </div>
          </section>

          {/* Mobile */}
          <section>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
              Mobile
            </h3>
            <div className="bg-white rounded-lg border border-gray-200 p-5">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-gray-800">Visible on Mobile</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    Employees can self-select this activity from the mobile picker.
                  </div>
                </div>
                <Toggle value={visibleOnMobile} onChange={setVisibleOnMobile} />
              </div>
            </div>
          </section>

          {mutation.isError && (
            <p className="text-sm text-red-600">
              {mutation.error instanceof Error
                ? mutation.error.message
                : 'Failed to create activity. Please try again.'}
            </p>
          )}

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={!canSubmit}
              className="px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {mutation.isPending ? 'Creating…' : 'Create Activity'}
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors"
            >
              Cancel
            </button>
          </div>

        </form>
      </div>
    </div>
  );
}

function FormField({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
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
