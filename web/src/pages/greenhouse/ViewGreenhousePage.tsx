import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Map, Plus, Wrench } from 'lucide-react';
import { greenhouseApi } from '../../api/greenhouse';
import type { GreenhouseMapListItem } from '../../api/greenhouse';
import { GreenhouseCanvas } from './components/GreenhouseCanvas';

export function ViewGreenhousePage() {
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const { data: maps = [], isLoading } = useQuery({
    queryKey: ['greenhouse-maps'],
    queryFn: () => greenhouseApi.listMaps(),
  });

  const { data: mapDetail } = useQuery({
    queryKey: ['greenhouse-map', selectedId],
    queryFn: () => greenhouseApi.getMap(selectedId!),
    enabled: selectedId != null,
  });

  useEffect(() => {
    if (maps.length > 0 && selectedId == null) {
      setSelectedId(maps[0].id);
    }
  }, [maps.length]);

  // Group maps by site
  const bySite = maps.reduce<Record<string, GreenhouseMapListItem[]>>((acc, m) => {
    (acc[m.siteName] ??= []).push(m);
    return acc;
  }, {});

  return (
    <div className="-m-8 h-full flex overflow-hidden">
      {/* Left: map list */}
      <aside className="w-64 flex-shrink-0 flex flex-col border-r border-gray-200 bg-white">
        <div className="px-4 pt-4 pb-3 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">
            <Map size={12} />
            Greenhouse Maps
          </div>
          <button
            onClick={() => navigate('/greenhouse/builder/new')}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded-md font-medium text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors"
          >
            <Plus size={12} />
            New
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {isLoading && (
            <p className="px-4 py-6 text-xs text-gray-400 text-center">Loading…</p>
          )}
          {!isLoading && maps.length === 0 && (
            <div className="px-4 py-8 text-center">
              <p className="text-xs text-gray-400 mb-3">No maps yet</p>
              <button
                onClick={() => navigate('/greenhouse/builder/new')}
                className="text-xs text-emerald-600 hover:text-emerald-700 font-medium"
              >
                Create your first map →
              </button>
            </div>
          )}
          {Object.entries(bySite).map(([siteName, siteMapList]) => (
            <div key={siteName}>
              <div className="px-4 pt-3 pb-1 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                {siteName}
              </div>
              {siteMapList.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setSelectedId(m.id)}
                  className={`w-full text-left px-4 py-2.5 border-l-2 transition-colors ${
                    m.id === selectedId
                      ? 'bg-emerald-50 border-emerald-500'
                      : 'border-transparent hover:bg-gray-50'
                  }`}
                >
                  <p className="text-sm font-medium text-gray-900 truncate">{m.name}</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {m.compartmentCount} compartments · {m.rowCount} rows
                  </p>
                </button>
              ))}
            </div>
          ))}
        </div>
      </aside>

      {/* Right: canvas */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {selectedId == null ? (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-400 bg-gray-50">
            Select a map
          </div>
        ) : (
          <>
            {/* Canvas header */}
            <div className="flex-shrink-0 px-6 py-3 bg-white border-b border-gray-200 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-gray-900">
                  {mapDetail?.name ?? '…'}
                </h2>
                <p className="text-xs text-gray-400">{mapDetail?.siteName}</p>
              </div>
              <button
                onClick={() => navigate(`/greenhouse/builder/${selectedId}`)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-emerald-600 text-white rounded-md hover:bg-emerald-700 transition-colors"
              >
                <Wrench size={12} />
                Build
              </button>
            </div>

            {mapDetail ? (
              <GreenhouseCanvas
                compartments={mapDetail.compartments}
                northExtentFt={mapDetail.northExtentFt}
                southExtentFt={mapDetail.southExtentFt}
                eastExtentFt={mapDetail.eastExtentFt}
                westExtentFt={mapDetail.westExtentFt}
                readOnly
              />
            ) : (
              <div className="flex-1 flex items-center justify-center text-sm text-gray-400 bg-gray-50">
                Loading…
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
