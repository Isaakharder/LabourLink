import { useState, useEffect } from 'react';
import { Pencil, X, Check } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Activity } from '../../../api/activities';
import { activityApi } from '../../../api/activities';

interface Props {
  activity: Activity;
}

interface RuleField {
  key: keyof Pick<
    Activity,
    | 'requiresLocation'
    | 'requiresCarrier'
    | 'requiresYield'
    | 'requiresCrop'
    | 'requiresNote'
    | 'requiresPhoto'
    | 'requiresQuestion'
  >;
  label: string;
  description: string;
  reserved?: boolean;
}

const RULES: RuleField[] = [
  {
    key: 'requiresLocation',
    label: 'Requires Location',
    description: 'Employee must select a row or location before the registration is saved.',
  },
  {
    key: 'requiresCarrier',
    label: 'Requires Carrier',
    description: 'Employee must select a carrier (trolley, crate, etc.) before saving.',
  },
  {
    key: 'requiresYield',
    label: 'Requires Yield',
    description: 'Employee must enter a yield quantity before saving.',
  },
  {
    key: 'requiresCrop',
    label: 'Requires Crop',
    description: 'Employee must select a crop or variety before saving.',
  },
  {
    key: 'requiresNote',
    label: 'Requires Note',
    description: 'Employee must enter a text note before saving.',
    reserved: true,
  },
  {
    key: 'requiresPhoto',
    label: 'Requires Photo',
    description: 'Employee must attach a photo before saving.',
    reserved: true,
  },
  {
    key: 'requiresQuestion',
    label: 'Requires Question',
    description: 'Employee must answer a configured question before saving.',
    reserved: true,
  },
];

type RulesForm = Record<
  | 'requiresLocation'
  | 'requiresCarrier'
  | 'requiresYield'
  | 'requiresCrop'
  | 'requiresNote'
  | 'requiresPhoto'
  | 'requiresQuestion',
  boolean
>;

function toForm(a: Activity): RulesForm {
  return {
    requiresLocation: a.requiresLocation,
    requiresCarrier:  a.requiresCarrier,
    requiresYield:    a.requiresYield,
    requiresCrop:     a.requiresCrop,
    requiresNote:     a.requiresNote,
    requiresPhoto:    a.requiresPhoto,
    requiresQuestion: a.requiresQuestion,
  };
}

export function RulesTab({ activity }: Props) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<RulesForm>(toForm(activity));

  useEffect(() => {
    setForm(toForm(activity));
    setEditing(false);
  }, [activity.id]);

  const mutation = useMutation({
    mutationFn: (data: Partial<RulesForm>) => activityApi.update(activity.id, data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['activities'] });
      void qc.invalidateQueries({ queryKey: ['activity', activity.id] });
      setEditing(false);
    },
  });

  function handleSave() {
    mutation.mutate(form);
  }

  function handleCancel() {
    setForm(toForm(activity));
    setEditing(false);
  }

  const active = RULES.filter(r => !r.reserved);
  const reserved = RULES.filter(r => r.reserved);

  return (
    <div className="px-8 py-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Input Rules</h3>
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

      <p className="text-sm text-gray-500 mb-5">
        When a rule is enabled, employees must provide the required information
        before a registration using this activity can be saved on the mobile device.
      </p>

      {/* Active rules */}
      <div className="mb-6">
        <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Active Rules</h4>
        <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
          {active.map(rule => (
            <RuleRow
              key={rule.key}
              rule={rule}
              value={editing ? form[rule.key] : activity[rule.key]}
              editing={editing}
              onChange={val => setForm(f => ({ ...f, [rule.key]: val }))}
            />
          ))}
        </div>
      </div>

      {/* Reserved rules */}
      <div className="mb-6">
        <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
          Reserved — Coming Soon
        </h4>
        <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100 opacity-60">
          {reserved.map(rule => (
            <RuleRow
              key={rule.key}
              rule={rule}
              value={editing ? form[rule.key] : activity[rule.key]}
              editing={editing}
              onChange={val => setForm(f => ({ ...f, [rule.key]: val }))}
            />
          ))}
        </div>
      </div>

      {editing && (
        <>
          {mutation.isError && (
            <p className="mb-4 text-sm text-red-600">
              {mutation.error instanceof Error ? mutation.error.message : 'Failed to save. Please try again.'}
            </p>
          )}
          <div className="flex items-center gap-3">
            <button
              onClick={handleSave}
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
        </>
      )}
    </div>
  );
}

function RuleRow({
  rule,
  value,
  editing,
  onChange,
}: {
  rule: RuleField;
  value: boolean;
  editing: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-4 px-5 py-4">
      <div className="flex-1">
        <div className="text-sm font-medium text-gray-800">{rule.label}</div>
        <div className="text-xs text-gray-500 mt-0.5">{rule.description}</div>
      </div>
      {editing ? (
        <Toggle value={value} onChange={onChange} />
      ) : (
        <span
          className={`flex-shrink-0 text-xs font-medium px-2 py-0.5 rounded ${
            value ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'
          }`}
        >
          {value ? 'Required' : 'Optional'}
        </span>
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
