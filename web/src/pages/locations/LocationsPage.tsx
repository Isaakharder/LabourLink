import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { locationApi } from '../../api/locations';
import { LocationList } from './LocationList';
import { LocationDetail } from './LocationDetail';
import { NewLocationForm } from './NewLocationForm';

export function LocationsPage() {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [isNew, setIsNew] = useState(false);
  const qc = useQueryClient();

  const { data: locations = [], isLoading } = useQuery({
    queryKey: ['locations'],
    queryFn: () => locationApi.list(undefined, true), // include archived so list shows all
  });

  // Auto-select first active location on load
  useEffect(() => {
    if (locations.length > 0 && !selectedId && !isNew) {
      const first = locations.find(l => !l.archivedAt) ?? locations[0];
      setSelectedId(first.id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locations.length]);

  function handleSelect(id: number) {
    setSelectedId(id);
    setIsNew(false);
  }

  function handleNew() {
    setIsNew(true);
    setSelectedId(null);
  }

  function handleCreated(id: number) {
    void qc.invalidateQueries({ queryKey: ['locations'] });
    setIsNew(false);
    setSelectedId(id);
  }

  function handleCancelNew() {
    setIsNew(false);
    if (!selectedId && locations.length > 0) {
      setSelectedId(locations[0].id);
    }
  }

  function handleRefresh() {
    void qc.invalidateQueries({ queryKey: ['locations'] });
    void qc.invalidateQueries({ queryKey: ['location', selectedId] });
  }

  return (
    <div className="-m-8 h-full flex overflow-hidden">
      <LocationList
        locations={locations}
        isLoading={isLoading}
        selectedId={selectedId}
        isNew={isNew}
        onSelect={handleSelect}
        onNew={handleNew}
      />

      <div className="flex-1 overflow-hidden">
        {isNew ? (
          <NewLocationForm
            onCreated={handleCreated}
            onCancel={handleCancelNew}
          />
        ) : selectedId !== null ? (
          <LocationDetail
            locationId={selectedId}
            onRefresh={handleRefresh}
          />
        ) : (
          <div className="h-full flex items-center justify-center text-sm text-gray-400">
            {isLoading ? 'Loading…' : 'Select a location or create a new one'}
          </div>
        )}
      </div>
    </div>
  );
}
