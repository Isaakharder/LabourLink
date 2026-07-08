import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { locationApi } from '../../api/locations';
import { LocationGroupList } from './LocationGroupList';
import { LocationGroupDetail } from './LocationGroupDetail';
import { NewLocationGroupForm } from './NewLocationGroupForm';

export function LocationGroupsPage() {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [isNew, setIsNew] = useState(false);
  const qc = useQueryClient();

  const { data: groups = [], isLoading } = useQuery({
    queryKey: ['location-groups-all'],
    queryFn: () => locationApi.groupList(undefined, true),
  });

  useEffect(() => {
    if (groups.length > 0 && !selectedId && !isNew) {
      const first = groups.find(g => !g.archivedAt) ?? groups[0];
      setSelectedId(first.id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups.length]);

  function handleSelect(id: number) {
    setSelectedId(id);
    setIsNew(false);
  }

  function handleNew() {
    setIsNew(true);
    setSelectedId(null);
  }

  function handleCreated(id: number) {
    void qc.invalidateQueries({ queryKey: ['location-groups-all'] });
    setIsNew(false);
    setSelectedId(id);
  }

  function handleRefresh() {
    void qc.invalidateQueries({ queryKey: ['location-groups-all'] });
    void qc.invalidateQueries({ queryKey: ['location-group', selectedId] });
  }

  return (
    <div className="-m-8 h-full flex overflow-hidden">
      <LocationGroupList
        groups={groups}
        isLoading={isLoading}
        selectedId={selectedId}
        isNew={isNew}
        onSelect={handleSelect}
        onNew={handleNew}
      />

      <div className="flex-1 overflow-hidden">
        {isNew ? (
          <NewLocationGroupForm onCreated={handleCreated} onCancel={() => setIsNew(false)} />
        ) : selectedId !== null ? (
          <LocationGroupDetail groupId={selectedId} onRefresh={handleRefresh} />
        ) : (
          <div className="h-full flex items-center justify-center text-sm text-gray-400">
            {isLoading ? 'Loading…' : 'Select a location group or create a new one'}
          </div>
        )}
      </div>
    </div>
  );
}
