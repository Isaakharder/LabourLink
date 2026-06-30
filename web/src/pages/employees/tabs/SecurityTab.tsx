import type { ReactNode } from 'react';
import { Shield, Key, Clock } from 'lucide-react';
import type { Employee } from '../../../api/employees';
import { formatDateTime } from '../helpers';

interface Props {
  employee: Employee;
}

export function SecurityTab({ employee }: Props) {
  const role = employee.securityRole ?? 'General';

  return (
    <div className="px-8 py-6">
      <SectionBlock title="Access Level">
        <div className="flex items-start gap-3">
          <Shield size={16} className="text-gray-400 mt-0.5 flex-shrink-0" />
          <div>
            <div className="text-sm font-medium text-gray-800">{role}</div>
            <div className="text-xs text-gray-400 mt-0.5">{roleDescription(role)}</div>
          </div>
        </div>
      </SectionBlock>

      <SectionBlock title="PIN">
        <div className="flex items-start gap-3">
          <Key size={16} className="text-gray-400 mt-0.5 flex-shrink-0" />
          {employee.hasPin ? (
            <div>
              <div className="text-sm font-medium text-gray-800">PIN is configured</div>
              <div className="text-xs text-gray-400 mt-0.5">
                Stored as a bcrypt hash — the PIN itself is never readable
              </div>
            </div>
          ) : (
            <div className="text-sm text-gray-400 italic">No PIN configured</div>
          )}
        </div>
      </SectionBlock>

      {employee.lastLoginAt && (
        <SectionBlock title="Last Login">
          <div className="flex items-center gap-3">
            <Clock size={16} className="text-gray-400 flex-shrink-0" />
            <div className="text-sm text-gray-700">{formatDateTime(employee.lastLoginAt)}</div>
          </div>
        </SectionBlock>
      )}
    </div>
  );
}

function SectionBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-6">
      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">{title}</h3>
      <div className="bg-white rounded-lg border border-gray-200 p-5">{children}</div>
    </div>
  );
}

const ROLE_DESCRIPTIONS: Record<string, string> = {
  Admin:        'Full system access including configuration and user management',
  Manager:      'Can manage all data including contracts and locations',
  Supervisor:   'Can manage employees and registrations within their site',
  'Crew Leader':'Can view team registrations and close shifts for others',
  General:      'Mobile clock-in/clock-out access only',
};

function roleDescription(role: string): string {
  return ROLE_DESCRIPTIONS[role] ?? 'No description available';
}
