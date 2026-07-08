import { useState, useEffect } from 'react';
import { Tag } from 'lucide-react';
import type { Activity, ActivityTabId } from '../../api/activities';
import { ActivitySummaryCard } from './ActivitySummaryCard';
import { GeneralTab } from './tabs/GeneralTab';
import { RulesTab } from './tabs/RulesTab';
import { MobileTab } from './tabs/MobileTab';
import { HistoryTab } from './tabs/HistoryTab';

const TABS: { id: ActivityTabId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'rules',   label: 'Rules' },
  { id: 'mobile',  label: 'Mobile' },
  { id: 'history', label: 'History' },
];

interface Props {
  activity: Activity | null;
  isNew: boolean;
  newForm: React.ReactNode;
}

export function ActivityDetail({ activity, isNew, newForm }: Props) {
  const [activeTab, setActiveTab] = useState<ActivityTabId>('general');

  useEffect(() => {
    setActiveTab('general');
  }, [activity?.id]);

  if (isNew) {
    return <>{newForm}</>;
  }

  if (!activity) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <Tag size={40} className="mx-auto text-gray-300 mb-3" />
          <p className="text-sm text-gray-400">Select an activity to view details</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <ActivitySummaryCard activity={activity} />

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
            </button>
          ))}
        </nav>
      </div>

      <div className="flex-1 overflow-y-auto bg-gray-50">
        {activeTab === 'general' && <GeneralTab activity={activity} />}
        {activeTab === 'rules'   && <RulesTab   activity={activity} />}
        {activeTab === 'mobile'  && <MobileTab  activity={activity} />}
        {activeTab === 'history' && <HistoryTab activity={activity} />}
      </div>
    </div>
  );
}
