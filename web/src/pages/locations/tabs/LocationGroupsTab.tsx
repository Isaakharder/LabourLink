import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Minus } from 'lucide-react';
import { locationApi } from '../../../api/locations';
import type { LocationDetail, LocationGroupMember } from '../../../api/locations';

interface Props {
  location: LocationDetail;
}

export function LocationGroupsTab({ location }: Props) {
  const qc = useQueryClient();

  const { data: memberGroups = [], isLoading } = useQuery({
    queryKey: ['location-groups', location.id],
    queryFn: () => locationApi.locationGroups(location.id),
  });

  const { data: allGroups = [] } = useQuery({
    queryKey: ['location-groups-list', location.siteId],
    queryFn: () => locationApi.groupList(location.siteId),
  });

  const removeMut = useMutation({
    mutationFn: (groupId: number) => locationApi.removeFromGroup(groupId, location.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['location-groups', location.id] }),
  });

  const addMut = useMutation({
    mutationFn: (groupId: number) => locationApi.addToGroup(groupId, location.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['location-groups', location.id] }),
  });

  const memberIds = new Set(memberGroups.map((g: LocationGroupMember) => g.id));
  const available = allGroups.filter(g => !memberIds.has(g.id) && !g.archivedAt);

  return (
    <div className="px-8 py-6 max-w-xl">
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
        Group Membership
      </p>

      {isLoading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : memberGroups.length === 0 ? (
        <p className="text-sm text-gray-400 mb-4">This location is not in any group.</p>
      ) : (
        <ul className="space-y-2 mb-6">
          {memberGroups.map((g: LocationGroupMember) => (
            <li key={g.id} className="flex items-center justify-between bg-gray-50 border border-gray-200 rounded-md px-4 py-2.5">
              <div>
                <p className="text-sm font-medium text-gray-900">{g.name}</p>
                <p className="text-xs font-mono text-gray-400">{g.code}</p>
              </div>
              <button
                onClick={() => removeMut.mutate(g.id)}
                disabled={removeMut.isPending}
                className="text-gray-400 hover:text-red-500 transition-colors"
                title="Remove from group"
              >
                <Minus size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {available.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
            Add to Group
          </p>
          <div className="flex flex-wrap gap-2">
            {available.map(g => (
              <button
                key={g.id}
                onClick={() => addMut.mutate(g.id)}
                disabled={addMut.isPending}
                className="text-xs px-3 py-1.5 border border-gray-200 rounded-full text-gray-600 hover:border-emerald-500 hover:text-emerald-700 hover:bg-emerald-50 transition-colors disabled:opacity-50"
              >
                {g.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
