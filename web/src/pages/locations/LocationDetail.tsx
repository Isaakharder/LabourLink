import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { locationApi } from '../../api/locations';
import { GeneralTab } from './tabs/GeneralTab';
import { LocationGroupsTab } from './tabs/LocationGroupsTab';
import { ScanCodesTab } from './tabs/ScanCodesTab';

type Tab = 'general' | 'groups' | 'scan-codes';

interface Props {
  locationId: number;
  onRefresh: () => void;
}

export function LocationDetail({ locationId, onRefresh }: Props) {
  const [tab, setTab] = useState<Tab>('general');

  useEffect(() => {
    setTab('general');
  }, [locationId]);

  const { data: location, isLoading, isError } = useQuery({
    queryKey: ['location', locationId],
    queryFn: () => locationApi.detail(locationId),
  });

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-gray-400">Loading…</div>
    );
  }
  if (isError || !location) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-red-500">
        Failed to load location
      </div>
    );
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'general',    label: 'General'    },
    { id: 'groups',     label: 'Groups'     },
    { id: 'scan-codes', label: 'Scan Codes' },
  ];

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 bg-white border-b border-gray-200 px-8 py-5">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-gray-900">{location.name}</h2>
              {location.archivedAt && (
                <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full font-medium">
                  Inactive
                </span>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-0.5">
              <span className="font-mono">{location.code}</span>
              {' · '}
              {location.siteName}
            </p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mt-4">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                tab === t.id
                  ? 'bg-emerald-50 text-emerald-700'
                  : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto bg-white">
        {tab === 'general'    && <GeneralTab    location={location} onRefresh={onRefresh} />}
        {tab === 'groups'     && <LocationGroupsTab location={location} />}
        {tab === 'scan-codes' && <ScanCodesTab  location={location} />}
      </div>
    </div>
  );
}
