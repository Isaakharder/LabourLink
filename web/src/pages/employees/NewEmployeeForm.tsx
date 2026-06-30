import { useState } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { employeeApi } from '../../api/employees';

interface Props {
  onCancel: () => void;
  onCreated: (id: number) => void;
}

const inputCls =
  'w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500';

const selectCls =
  'w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500';

export function NewEmployeeForm({ onCancel, onCreated }: Props) {
  const [firstName,          setFirstName]          = useState('');
  const [lastName,           setLastName]           = useState('');
  const [dateOfBirth,        setDateOfBirth]        = useState('');
  const [phone,              setPhone]              = useState('');
  const [email,              setEmail]              = useState('');
  const [siteId,             setSiteId]             = useState('');
  const [startedOn,          setStartedOn]          = useState('');
  const [jobRoleId,          setJobRoleId]          = useState('');
  const [contractTemplateId, setContractTemplateId] = useState('');
  const [securityRoleId,     setSecurityRoleId]     = useState('');

  const { data: options, isLoading: optionsLoading } = useQuery({
    queryKey: ['employee-form-options'],
    queryFn: employeeApi.formOptions,
  });

  const mutation = useMutation({
    mutationFn: employeeApi.create,
    onSuccess: ({ id }) => onCreated(id),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!firstName || !lastName || !siteId || !startedOn) return;

    mutation.mutate({
      firstName,
      lastName,
      dateOfBirth:        dateOfBirth        || undefined,
      phone:              phone              || undefined,
      email:              email              || undefined,
      siteId:             parseInt(siteId, 10),
      startedOn,
      jobRoleId:          jobRoleId          ? parseInt(jobRoleId, 10)          : undefined,
      contractTemplateId: contractTemplateId ? parseInt(contractTemplateId, 10) : undefined,
      securityRoleId:     securityRoleId     ? parseInt(securityRoleId, 10)     : undefined,
    });
  }

  // Default security role label for the placeholder
  const defaultRole = options?.securityRoles.find(r => r.name === 'General');

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="bg-white border-b border-gray-200 px-8 py-5 flex-shrink-0 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">New Employee</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            Fill in the details to create the employee record.
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

      <div className="flex-1 overflow-y-auto bg-gray-50 px-8 py-6">
        <form onSubmit={handleSubmit} className="max-w-lg space-y-6">

          {/* Personal Details */}
          <section>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
              Personal Details
            </h3>
            <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <FormField label="First Name" required>
                  <input
                    type="text"
                    value={firstName}
                    onChange={e => setFirstName(e.target.value)}
                    className={inputCls}
                    placeholder="First name"
                    required
                  />
                </FormField>
                <FormField label="Last Name" required>
                  <input
                    type="text"
                    value={lastName}
                    onChange={e => setLastName(e.target.value)}
                    className={inputCls}
                    placeholder="Last name"
                    required
                  />
                </FormField>
              </div>
              <FormField label="Date of Birth">
                <input
                  type="date"
                  value={dateOfBirth}
                  onChange={e => setDateOfBirth(e.target.value)}
                  className={inputCls}
                />
              </FormField>
              <FormField label="Phone">
                <input
                  type="tel"
                  value={phone}
                  onChange={e => setPhone(e.target.value)}
                  className={inputCls}
                  placeholder="+31 6 00000000"
                />
              </FormField>
              <FormField label="Email">
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  className={inputCls}
                  placeholder="employee@example.com"
                />
              </FormField>
            </div>
          </section>

          {/* Employment */}
          <section>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
              Employment
            </h3>
            <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
              <FormField label="Site" required>
                <select
                  value={siteId}
                  onChange={e => setSiteId(e.target.value)}
                  className={selectCls}
                  required
                  disabled={optionsLoading}
                >
                  <option value="">Select site…</option>
                  {options?.sites.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </FormField>
              <FormField label="Start Date" required>
                <input
                  type="date"
                  value={startedOn}
                  onChange={e => setStartedOn(e.target.value)}
                  className={inputCls}
                  required
                />
              </FormField>
              <div className="grid grid-cols-2 gap-4">
                <FormField label="Job Role">
                  <select
                    value={jobRoleId}
                    onChange={e => setJobRoleId(e.target.value)}
                    className={selectCls}
                    disabled={optionsLoading}
                  >
                    <option value="">None</option>
                    {options?.jobRoles.map(r => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                </FormField>
                <FormField label="Contract">
                  <select
                    value={contractTemplateId}
                    onChange={e => setContractTemplateId(e.target.value)}
                    className={selectCls}
                    disabled={optionsLoading}
                  >
                    <option value="">None</option>
                    {options?.contractTemplates.map(c => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </FormField>
              </div>
            </div>
          </section>

          {/* Security */}
          <section>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
              Security
            </h3>
            <div className="bg-white rounded-lg border border-gray-200 p-5">
              <FormField label="Security Role">
                <select
                  value={securityRoleId}
                  onChange={e => setSecurityRoleId(e.target.value)}
                  className={selectCls}
                  disabled={optionsLoading}
                >
                  <option value="">
                    {defaultRole ? `General (default)` : 'Default'}
                  </option>
                  {options?.securityRoles.map(r => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </FormField>
            </div>
          </section>

          {mutation.isError && (
            <p className="text-sm text-red-600">
              Failed to create employee. Please try again.
            </p>
          )}

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={mutation.isPending || !firstName || !lastName || !siteId || !startedOn}
              className="px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {mutation.isPending ? 'Creating…' : 'Create Employee'}
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
