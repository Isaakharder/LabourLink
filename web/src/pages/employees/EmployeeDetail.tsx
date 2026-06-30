import { useState, useEffect } from 'react';
import { Users } from 'lucide-react';
import type { MockEmployee, TabId } from './mock-data';
import { EmployeeSummaryCard } from './EmployeeSummaryCard';
import { NewEmployeeForm } from './NewEmployeeForm';
import { GeneralTab } from './tabs/GeneralTab';
import { EmploymentTab } from './tabs/EmploymentTab';
import { CareerTab } from './tabs/CareerTab';
import { SecurityTab } from './tabs/SecurityTab';
import { DevicesTab } from './tabs/DevicesTab';
import { NotesTab } from './tabs/NotesTab';
import { TimelineTab } from './tabs/TimelineTab';

const TABS: { id: TabId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'employment', label: 'Employment' },
  { id: 'career', label: 'Career' },
  { id: 'security', label: 'Security' },
  { id: 'devices', label: 'Devices' },
  { id: 'notes', label: 'Notes' },
  { id: 'timeline', label: 'Timeline' },
];

interface Props {
  employee: MockEmployee | null;
  isNew: boolean;
  onCancelNew: () => void;
}

export function EmployeeDetail({ employee, isNew, onCancelNew }: Props) {
  const [activeTab, setActiveTab] = useState<TabId>('general');

  useEffect(() => {
    setActiveTab('general');
  }, [employee?.id]);

  if (isNew) {
    return <NewEmployeeForm onCancel={onCancelNew} />;
  }

  if (!employee) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <Users size={40} className="mx-auto text-gray-300 mb-3" />
          <p className="text-sm text-gray-400">Select an employee to view details</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <EmployeeSummaryCard employee={employee} />

      <div className="bg-white border-b border-gray-200 px-8 flex-shrink-0">
        <nav className="flex -mb-px overflow-x-auto">
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap flex-shrink-0 ${
                activeTab === tab.id
                  ? 'border-emerald-600 text-emerald-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="flex-1 overflow-y-auto bg-gray-50">
        {activeTab === 'general' && <GeneralTab employee={employee} />}
        {activeTab === 'employment' && <EmploymentTab employee={employee} />}
        {activeTab === 'career' && <CareerTab employee={employee} />}
        {activeTab === 'security' && <SecurityTab employee={employee} />}
        {activeTab === 'devices' && <DevicesTab employee={employee} />}
        {activeTab === 'notes' && <NotesTab employee={employee} />}
        {activeTab === 'timeline' && <TimelineTab employee={employee} />}
      </div>
    </div>
  );
}
