import { useState, useEffect } from 'react';
import { FileText } from 'lucide-react';
import type { ContractDetail as ContractDetailType } from '../../api/contracts';
import { GeneralTab } from './tabs/GeneralTab';
import { ProfilesTab } from './tabs/ProfilesTab';

type TabId = 'general' | 'profiles';
const TABS: { id: TabId; label: string }[] = [
  { id: 'general',  label: 'General'  },
  { id: 'profiles', label: 'Profiles' },
];

interface Props {
  contract: ContractDetailType | null;
  onUpdated: () => void;
}

export function ContractDetail({ contract, onUpdated }: Props) {
  const [activeTab, setActiveTab] = useState<TabId>('general');

  useEffect(() => { setActiveTab('general'); }, [contract?.id]);

  if (!contract) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <FileText size={40} className="mx-auto text-gray-300 mb-3" />
          <p className="text-sm text-gray-400">Select a contract to view details</p>
        </div>
      </div>
    );
  }

  const isArchived = !!contract.archivedAt;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Summary header */}
      <div className="bg-white border-b border-gray-200 px-8 py-5 flex-shrink-0">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl font-semibold text-gray-900">{contract.name}</h1>
              {isArchived ? (
                <span className="px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-500">Archived</span>
              ) : (
                <span className="px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-700">Active</span>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-1">
              {contract.profiles.filter(p => !p.archivedAt).length} profile version
              {contract.profiles.filter(p => !p.archivedAt).length !== 1 ? 's' : ''}
            </p>
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <div className="bg-white border-b border-gray-200 px-8 flex-shrink-0">
        <nav className="flex -mb-px">
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab.id
                  ? 'border-emerald-600 text-emerald-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab.label}
              {tab.id === 'profiles' && contract.profiles.filter(p => !p.archivedAt).length > 0 && (
                <span className="ml-1.5 text-xs text-gray-400">
                  {contract.profiles.filter(p => !p.archivedAt).length}
                </span>
              )}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto bg-gray-50">
        {activeTab === 'general'  && <GeneralTab  contract={contract} onUpdated={onUpdated} />}
        {activeTab === 'profiles' && <ProfilesTab contract={contract} onUpdated={onUpdated} />}
      </div>
    </div>
  );
}
