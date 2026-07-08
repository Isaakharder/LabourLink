import { useState } from 'react';
import { Plus, Copy, ChevronDown, ChevronUp, AlertCircle, Check } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ContractDetail, ContractProfile, CreateProfileInput } from '../../../api/contracts';
import { contractApi } from '../../../api/contracts';

interface Props {
  contract: ContractDetail;
  onUpdated: () => void;
}

const ROUNDING_LABELS: Record<string, string> = {
  none:       'No rounding',
  round_up:   'Round up',
  round_down: 'Round down',
  nearest:    'Round to nearest',
};

const inputCls = 'w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500';
const selectCls = inputCls;

function fmtDate(iso: string) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ── Profile Form ──────────────────────────────────────────────────────────────

interface ProfileFormState {
  effectiveFrom: string;
  hoursPerWeek: string;
  workStartRoundingRule: string;
  workStartRoundingMinutes: string;
  allowNightWork: boolean;
  publicHolidayRule: string;
}

const emptyForm = (): ProfileFormState => ({
  effectiveFrom: '',
  hoursPerWeek: '',
  workStartRoundingRule: 'none',
  workStartRoundingMinutes: '15',
  allowNightWork: false,
  publicHolidayRule: '',
});

function profileToForm(p: ContractProfile): ProfileFormState {
  return {
    effectiveFrom: '',
    hoursPerWeek:  p.hoursPerWeek !== null ? String(p.hoursPerWeek) : '',
    workStartRoundingRule:    p.workStartRoundingRule,
    workStartRoundingMinutes: String(p.workStartRoundingMinutes),
    allowNightWork:    p.allowNightWork,
    publicHolidayRule: p.publicHolidayRule ?? '',
  };
}

function formToInput(f: ProfileFormState): CreateProfileInput {
  return {
    effectiveFrom:            f.effectiveFrom,
    hoursPerWeek:             f.hoursPerWeek ? parseFloat(f.hoursPerWeek) : null,
    workStartRoundingRule:    f.workStartRoundingRule,
    workStartRoundingMinutes: parseInt(f.workStartRoundingMinutes, 10) || 15,
    allowNightWork:           f.allowNightWork,
    publicHolidayRule:        f.publicHolidayRule || null,
  };
}

function ProfileForm({
  contractId,
  cloneSourceId,
  onSaved,
  onCancel,
  initial,
}: {
  contractId: number;
  cloneSourceId: number | null;
  onSaved: () => void;
  onCancel: () => void;
  initial: ProfileFormState;
}) {
  const [form, setForm] = useState<ProfileFormState>(initial);

  const createMutation = useMutation({
    mutationFn: () => {
      const input = formToInput(form);
      if (cloneSourceId !== null) {
        return contractApi.cloneProfile(contractId, cloneSourceId, input.effectiveFrom);
      }
      return contractApi.createProfile(contractId, input);
    },
    onSuccess: onSaved,
  });

  function set<K extends keyof ProfileFormState>(key: K, value: ProfileFormState[K]) {
    setForm(f => ({ ...f, [key]: value }));
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-5 mb-4">
      <h4 className="text-sm font-semibold text-gray-700 mb-4">
        {cloneSourceId !== null ? 'Clone Profile' : 'New Profile'}
      </h4>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Effective From <span className="text-red-500">*</span>
          </label>
          <input type="date" value={form.effectiveFrom} onChange={e => set('effectiveFrom', e.target.value)} className={inputCls} />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Hours per Week</label>
          <input
            type="number" min="0" max="168" step="0.5"
            value={form.hoursPerWeek}
            onChange={e => set('hoursPerWeek', e.target.value)}
            placeholder="e.g. 40"
            className={inputCls}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Work Start Rounding</label>
          <select value={form.workStartRoundingRule} onChange={e => set('workStartRoundingRule', e.target.value)} className={selectCls}>
            <option value="none">No rounding</option>
            <option value="round_up">Round up</option>
            <option value="round_down">Round down</option>
            <option value="nearest">Round to nearest</option>
          </select>
        </div>

        {form.workStartRoundingRule !== 'none' && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Rounding Range (minutes)</label>
            <input
              type="number" min="1" max="60"
              value={form.workStartRoundingMinutes}
              onChange={e => set('workStartRoundingMinutes', e.target.value)}
              className={`${inputCls} w-32`}
            />
          </div>
        )}

        <div className="col-span-2 flex items-center gap-3">
          <input
            type="checkbox"
            id="allowNightWork"
            checked={form.allowNightWork}
            onChange={e => set('allowNightWork', e.target.checked)}
            className="w-4 h-4 text-emerald-600 rounded border-gray-300"
          />
          <label htmlFor="allowNightWork" className="text-sm text-gray-700">Allow night work</label>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Public Holiday Rule
            <span className="ml-1.5 text-xs font-normal text-gray-400">(placeholder)</span>
          </label>
          <input
            type="text"
            value={form.publicHolidayRule}
            onChange={e => set('publicHolidayRule', e.target.value)}
            placeholder="e.g. standard, double_pay"
            className={inputCls}
          />
        </div>
      </div>

      {/* Placeholders for future sections */}
      <div className="mt-4 flex flex-wrap gap-2">
        {['Breaks', 'Wages', 'Overtime'].map(section => (
          <span key={section} className="text-xs text-gray-400 bg-gray-100 px-2.5 py-1 rounded-full">
            {section} — configured in future version
          </span>
        ))}
      </div>

      {createMutation.isError && (
        <p className="mt-3 text-sm text-red-600 flex items-center gap-1.5">
          <AlertCircle size={14} />
          {createMutation.error instanceof Error ? createMutation.error.message : 'Failed to save'}
        </p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={() => createMutation.mutate()}
          disabled={!form.effectiveFrom || createMutation.isPending}
          className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 transition-colors disabled:opacity-50"
        >
          <Check size={13} />
          {createMutation.isPending ? 'Saving…' : 'Save Profile'}
        </button>
        <button onClick={onCancel} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 transition-colors">
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Profile Card ──────────────────────────────────────────────────────────────

function ProfileCard({
  profile,
  isCurrent,
  onClone,
}: {
  profile: ContractProfile;
  isCurrent: boolean;
  onClone: (p: ContractProfile) => void;
}) {
  const [expanded, setExpanded] = useState(isCurrent);

  return (
    <div className={`bg-white border rounded-lg overflow-hidden ${isCurrent ? 'border-emerald-200' : 'border-gray-200'} ${profile.archivedAt ? 'opacity-50' : ''}`}>
      {/* Card header */}
      <div
        className="px-5 py-3.5 flex items-center justify-between cursor-pointer hover:bg-gray-50 transition-colors"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="flex items-center gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-900">From {fmtDate(profile.effectiveFrom)}</span>
              {isCurrent && (
                <span className="text-xs bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full font-medium">
                  Current
                </span>
              )}
              {profile.archivedAt && (
                <span className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded-full">Archived</span>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-0.5">
              {profile.hoursPerWeek !== null ? `${profile.hoursPerWeek}h/week` : 'Hours not set'}
              {profile.workStartRoundingRule !== 'none' && ` · ${ROUNDING_LABELS[profile.workStartRoundingRule]} ${profile.workStartRoundingMinutes}m`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {!profile.archivedAt && (
            <button
              onClick={e => { e.stopPropagation(); onClone(profile); }}
              className="flex items-center gap-1 text-xs text-gray-500 hover:text-emerald-700 transition-colors px-2 py-1 rounded hover:bg-emerald-50"
            >
              <Copy size={11} /> Clone
            </button>
          )}
          {expanded ? <ChevronUp size={14} className="text-gray-400" /> : <ChevronDown size={14} className="text-gray-400" />}
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-5 pb-4 border-t border-gray-100 pt-4 grid grid-cols-3 gap-4">
          <Field label="Hours / Week"    value={profile.hoursPerWeek !== null ? `${profile.hoursPerWeek}h` : '—'} />
          <Field label="Start Rounding"  value={ROUNDING_LABELS[profile.workStartRoundingRule] ?? profile.workStartRoundingRule} />
          <Field label="Rounding Range"  value={profile.workStartRoundingRule !== 'none' ? `${profile.workStartRoundingMinutes} min` : '—'} />
          <Field label="Night Work"      value={profile.allowNightWork ? 'Allowed' : 'Not allowed'} />
          <Field label="Public Holidays" value={profile.publicHolidayRule ?? '—'} />
          <div className="col-span-3 flex gap-2 pt-1">
            {['Breaks', 'Wages', 'Overtime'].map(s => (
              <span key={s} className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                {s}: future
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-gray-400 mb-0.5">{label}</div>
      <div className="text-sm text-gray-800">{value}</div>
    </div>
  );
}

// ── Profiles Tab ──────────────────────────────────────────────────────────────

export function ProfilesTab({ contract, onUpdated }: Props) {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [cloneSource, setCloneSource] = useState<ContractProfile | null>(null);

  const activeProfiles = contract.profiles.filter(p => !p.archivedAt);

  function handleClone(profile: ContractProfile) {
    setCloneSource(profile);
    setShowForm(true);
  }

  function handleNewProfile() {
    setCloneSource(null);
    setShowForm(true);
  }

  function handleSaved() {
    setShowForm(false);
    setCloneSource(null);
    void qc.invalidateQueries({ queryKey: ['contract', contract.id] });
    onUpdated();
  }

  function handleCancel() {
    setShowForm(false);
    setCloneSource(null);
  }

  return (
    <div className="px-8 py-6 max-w-2xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
          Profile Versions
        </h4>
        {!showForm && (
          <button
            onClick={handleNewProfile}
            className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 hover:text-emerald-800 transition-colors"
          >
            <Plus size={13} /> New Profile
          </button>
        )}
      </div>

      {/* Form */}
      {showForm && (
        <ProfileForm
          contractId={contract.id}
          cloneSourceId={cloneSource?.id ?? null}
          initial={cloneSource ? profileToForm(cloneSource) : emptyForm()}
          onSaved={handleSaved}
          onCancel={handleCancel}
        />
      )}

      {/* Profile list */}
      {activeProfiles.length === 0 && !showForm ? (
        <div className="text-center py-8">
          <p className="text-sm text-gray-400 mb-3">No profiles yet</p>
          <button
            onClick={handleNewProfile}
            className="flex items-center gap-1.5 text-sm font-medium text-emerald-700 hover:text-emerald-800 mx-auto transition-colors"
          >
            <Plus size={14} /> Add first profile
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {activeProfiles.map((profile, i) => (
            <ProfileCard
              key={profile.id}
              profile={profile}
              isCurrent={i === 0}
              onClone={handleClone}
            />
          ))}
        </div>
      )}

      {/* Archived profiles (collapsed by default) */}
      {contract.profiles.filter(p => p.archivedAt).length > 0 && (
        <div className="mt-4">
          <p className="text-xs text-gray-400 uppercase tracking-wider mb-2">Archived</p>
          <div className="space-y-2">
            {contract.profiles.filter(p => p.archivedAt).map(profile => (
              <ProfileCard key={profile.id} profile={profile} isCurrent={false} onClone={handleClone} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
