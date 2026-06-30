import { useState } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';

interface Props {
  onCancel: () => void;
}

const inputCls =
  'w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500';

export function NewEmployeeForm({ onCancel }: Props) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="bg-white border-b border-gray-200 px-8 py-5 flex-shrink-0 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">New Employee</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            Fill in the personal details to create the employee record.
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
        <div className="max-w-lg">
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
                />
              </FormField>
              <FormField label="Last Name" required>
                <input
                  type="text"
                  value={lastName}
                  onChange={e => setLastName(e.target.value)}
                  className={inputCls}
                  placeholder="Last name"
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

          <div className="mt-6 flex items-center gap-3">
            <button className="px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 transition-colors">
              Create Employee
            </button>
            <button
              onClick={onCancel}
              className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors"
            >
              Cancel
            </button>
          </div>

          <p className="mt-3 text-xs text-gray-400">
            Employment details, contract, and security role are configured after saving.
          </p>
        </div>
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
