import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { keepPreviousData } from '@tanstack/react-query';
import { activityApi } from '../../api/activities';
import { ActivityList } from './ActivityList';
import { ActivityDetail } from './ActivityDetail';
import { NewActivityForm } from './NewActivityForm';

export function ActivitiesPage() {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [isNew, setIsNew] = useState(false);
  const qc = useQueryClient();

  const { data: activities = [], isLoading } = useQuery({
    queryKey: ['activities'],
    queryFn: activityApi.list,
  });

  // Auto-select first activity once list loads
  useEffect(() => {
    if (activities.length > 0 && selectedId === null && !isNew) {
      setSelectedId(activities[0].id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activities.length]);

  const activeId = isNew ? null : selectedId;

  const { data: selectedActivity } = useQuery({
    queryKey: ['activity', activeId],
    queryFn: () => activityApi.detail(activeId!),
    enabled: activeId != null,
    placeholderData: keepPreviousData,
  });

  function handleSelect(id: number) {
    setSelectedId(id);
    setIsNew(false);
  }

  function handleNew() {
    setSelectedId(null);
    setIsNew(true);
  }

  function handleCancelNew() {
    setIsNew(false);
    if (activities.length > 0) setSelectedId(activities[0].id);
  }

  function handleCreated(id: number) {
    void qc.invalidateQueries({ queryKey: ['activities'] });
    setIsNew(false);
    setSelectedId(id);
  }

  return (
    <div className="-m-8 h-full flex overflow-hidden">
      <ActivityList
        activities={activities}
        isLoading={isLoading}
        selectedId={selectedId}
        onSelect={handleSelect}
        onNew={handleNew}
      />
      <ActivityDetail
        activity={selectedActivity ?? null}
        isNew={isNew}
        newForm={
          <NewActivityForm onCancel={handleCancelNew} onCreated={handleCreated} />
        }
      />
    </div>
  );
}
