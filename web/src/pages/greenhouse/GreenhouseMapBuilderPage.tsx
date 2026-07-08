import { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, ChevronDown, ChevronRight, Plus, Trash2, Rows3, Building2, X, Grid3X3, Scan, Settings2, ArrowUp, ArrowDown, ArrowLeft as ArrowWest, ArrowRight as ArrowEast } from 'lucide-react';
import { greenhouseApi } from '../../api/greenhouse';
import type { GreenhouseCompartmentDetail } from '../../api/greenhouse';
import { locationApi } from '../../api/locations';
import { GreenhouseCanvas } from './components/GreenhouseCanvas';
import type { GreenhouseCanvasHandle } from './components/GreenhouseCanvas';
import { RowBlockAddPanel } from './components/RowBlockAddPanel';
import { BlockDetailPanel } from './components/BlockDetailPanel';

const inputCls =
  'w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white placeholder:text-gray-400 ' +
  'focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500';
const labelCls = 'block text-xs font-medium text-gray-600 mb-1';

// ── Quick-create site modal (used inside New Map form) ────────────────────────

const SITE_TIMEZONES = [
  'UTC',
  'Europe/Amsterdam', 'Europe/Athens', 'Europe/Berlin', 'Europe/Brussels',
  'Europe/Dublin', 'Europe/Helsinki', 'Europe/Lisbon', 'Europe/London',
  'Europe/Madrid', 'Europe/Paris', 'Europe/Rome', 'Europe/Stockholm', 'Europe/Warsaw',
  'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/New_York', 'America/Sao_Paulo', 'America/Toronto',
  'Africa/Cairo', 'Africa/Johannesburg', 'Africa/Nairobi',
  'Asia/Dubai', 'Asia/Jerusalem', 'Asia/Kolkata', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Tokyo',
  'Australia/Melbourne', 'Australia/Perth', 'Australia/Sydney',
  'Pacific/Auckland',
];

function generateSiteCode(name: string): string {
  return name.trim().split(/\s+/).filter(Boolean).map(w => w[0] ?? '').join('').toUpperCase().slice(0, 8);
}

interface CreateSiteQuickModalProps {
  onCreated: (site: { id: number; name: string }) => void;
  onClose: () => void;
}

function CreateSiteQuickModal({ onCreated, onClose }: CreateSiteQuickModalProps) {
  const [siteName, setSiteName]   = useState('');
  const [code, setCode]           = useState('');
  const [address, setAddress]     = useState('');
  const [timezone, setTimezone]   = useState('Europe/Amsterdam');
  const [formErr, setFormErr]     = useState<string | null>(null);
  const codeManualRef             = useRef(false);

  useEffect(() => {
    if (!codeManualRef.current) setCode(generateSiteCode(siteName));
  }, [siteName]);

  const mut = useMutation({
    mutationFn: () => locationApi.createSite({ name: siteName.trim(), code: code.trim(), address: address.trim() || undefined, timezone }),
    onSuccess: (site) => onCreated(site),
    onError: (e: Error) => {
      const msg = e.message.replace(/^API \d+: /, '').replace(/^\{"error":"/, '').replace(/"\}$/, '');
      setFormErr(msg);
    },
  });

  const canSubmit = siteName.trim() && code.trim() && timezone && !mut.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-900">Create Site</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={15} /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Site Name <span className="text-red-500">*</span></label>
              <input
                type="text" value={siteName} onChange={e => setSiteName(e.target.value)}
                placeholder="First Light Farms" className={inputCls} autoFocus
              />
            </div>
            <div>
              <label className={labelCls}>Code <span className="text-red-500">*</span></label>
              <input
                type="text" value={code}
                onChange={e => { codeManualRef.current = true; setCode(e.target.value.toUpperCase()); }}
                placeholder="FLF" className={inputCls}
              />
            </div>
          </div>
          <div>
            <label className={labelCls}>Timezone <span className="text-red-500">*</span></label>
            <select value={timezone} onChange={e => setTimezone(e.target.value)} className={inputCls}>
              {SITE_TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Address</label>
            <input
              type="text" value={address} onChange={e => setAddress(e.target.value)}
              placeholder="Optional" className={inputCls}
            />
          </div>
          {formErr && <p className="text-xs text-red-600 bg-red-50 rounded px-3 py-2">{formErr}</p>}
          <div className="flex gap-3 pt-1">
            <button
              onClick={() => mut.mutate()} disabled={!canSubmit}
              className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Check size={13} />
              {mut.isPending ? 'Creating…' : 'Create Site'}
            </button>
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors">
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── New map form ───────────────────────────────────────────────────────────────

function NewMapForm() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName]                     = useState('');
  const [siteId, setSiteId]                 = useState('');
  const [err, setErr]                       = useState<string | null>(null);
  const [showSiteCreate, setShowSiteCreate] = useState(false);

  const { data: allSites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => locationApi.listSites(),
  });
  const sites = allSites.filter((s: { archivedAt: string | null }) => !s.archivedAt);

  const mutation = useMutation({
    mutationFn: () => greenhouseApi.createMap({ siteId: parseInt(siteId, 10), name: name.trim() }),
    onSuccess: ({ id }) => navigate(`/greenhouse/builder/${id}`, { replace: true }),
    onError: (e: Error) => setErr(e.message),
  });

  const handleSiteCreated = (site: { id: number; name: string }) => {
    void qc.invalidateQueries({ queryKey: ['sites'] });
    setSiteId(String(site.id));
    setShowSiteCreate(false);
  };

  const canSubmit = name.trim() && siteId && !mutation.isPending;

  const header = (
    <div className="flex-shrink-0 px-6 py-4 border-b border-gray-200 bg-white flex items-center gap-3">
      <button onClick={() => navigate('/greenhouse')} className="text-gray-400 hover:text-gray-600 transition-colors">
        <ArrowLeft size={16} />
      </button>
      <h1 className="text-sm font-semibold text-gray-900">New Greenhouse Map</h1>
    </div>
  );

  return (
    <>
      <div className="h-full flex flex-col">
        {header}
        <div className="flex-1 flex items-start justify-center bg-gray-50 p-8">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 w-full max-w-sm space-y-4">

            {/* Site field */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className={labelCls}>Site <span className="text-red-500">*</span></label>
                <button
                  type="button"
                  onClick={() => setShowSiteCreate(true)}
                  className="flex items-center gap-0.5 text-xs text-emerald-600 hover:text-emerald-700 font-medium transition-colors"
                >
                  <Plus size={11} />
                  New Site
                </button>
              </div>

              {sites.length === 0 && allSites.length === 0 ? (
                <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-5 text-center">
                  <div className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-emerald-50 mb-2">
                    <Building2 size={16} className="text-emerald-600" />
                  </div>
                  <p className="text-xs text-gray-500 mb-3">
                    No sites yet. Create your first site to continue.
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowSiteCreate(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white text-xs font-medium rounded-md hover:bg-emerald-700 transition-colors"
                  >
                    <Plus size={12} />
                    Create a Site
                  </button>
                </div>
              ) : (
                <>
                  <select value={siteId} onChange={(e) => setSiteId(e.target.value)} className={inputCls}>
                    <option value="">Select site…</option>
                    {sites.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                  {sites.length === 0 && allSites.length > 0 && (
                    <p className="mt-1 text-xs text-amber-600">
                      All sites are inactive.{' '}
                      <button onClick={() => navigate('/sites')} className="underline hover:text-amber-700">
                        Manage sites →
                      </button>
                    </p>
                  )}
                </>
              )}
            </div>

            {/* Map name */}
            {(sites.length > 0 || siteId) && (
              <div>
                <label className={labelCls}>Map Name <span className="text-red-500">*</span></label>
                <input
                  type="text" value={name} onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Main Greenhouse" className={inputCls}
                />
              </div>
            )}

            {err && <p className="text-xs text-red-600">{err}</p>}

            {(sites.length > 0 || siteId) && (
              <div className="flex items-center gap-3 pt-2">
                <button
                  onClick={() => mutation.mutate()} disabled={!canSubmit}
                  className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <Check size={13} />
                  {mutation.isPending ? 'Creating…' : 'Create Map'}
                </button>
                <button
                  onClick={() => navigate('/greenhouse')}
                  className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {showSiteCreate && (
        <CreateSiteQuickModal
          onCreated={handleSiteCreated}
          onClose={() => setShowSiteCreate(false)}
        />
      )}
    </>
  );
}

// ── Add compartment inline form ───────────────────────────────────────────────

function AddCompartmentForm({
  mapId,
  onCreated,
  onCancel,
}: {
  mapId: number;
  onCreated: (c: GreenhouseCompartmentDetail) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [eastWestFt, setEastWestFt] = useState('');
  const [northSouthFt, setNorthSouthFt] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      greenhouseApi.addCompartment(mapId, {
        name: name.trim(),
        eastWestFt: parseFloat(eastWestFt),
        northSouthFt: parseFloat(northSouthFt),
      }),
    onSuccess: (comp) => {
      onCreated(comp);
      setName(''); setEastWestFt(''); setNorthSouthFt('');
    },
    onError: (e: Error) => setErr(e.message),
  });

  const canSubmit = name.trim() && eastWestFt && northSouthFt && !mutation.isPending;

  return (
    <div className="mx-3 mt-2 mb-1 rounded-lg border border-emerald-200 bg-emerald-50 p-3 space-y-2">
      <p className="text-xs font-semibold text-emerald-700">New Compartment</p>
      <input
        type="text"
        placeholder="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className={inputCls + ' text-xs py-1.5'}
      />
      <div className="grid grid-cols-2 gap-2">
        <input
          type="number"
          placeholder="East ↔ West (ft)"
          value={eastWestFt}
          onChange={(e) => setEastWestFt(e.target.value)}
          className={inputCls + ' text-xs py-1.5'}
          title="Horizontal width — East to West"
        />
        <input
          type="number"
          placeholder="North ↕ South (ft)"
          value={northSouthFt}
          onChange={(e) => setNorthSouthFt(e.target.value)}
          className={inputCls + ' text-xs py-1.5'}
          title="Vertical length — North to South"
        />
      </div>
      <p className="text-[10px] text-emerald-600">E↔W = horizontal · N↕S = vertical (N at top)</p>
      {err && <p className="text-xs text-red-600">{err}</p>}
      <div className="flex gap-2">
        <button
          onClick={() => mutation.mutate()}
          disabled={!canSubmit}
          className="flex items-center gap-1 text-xs px-3 py-1.5 bg-emerald-600 text-white rounded-md hover:bg-emerald-700 disabled:opacity-50 transition-colors"
        >
          <Check size={11} />
          {mutation.isPending ? 'Adding…' : 'Add'}
        </button>
        <button
          onClick={onCancel}
          className="text-xs px-3 py-1.5 text-gray-500 hover:text-gray-700 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Compartment position panel ────────────────────────────────────────────────

function fmtDist(ft: number, posLabel: string, negLabel: string): string {
  if (Math.abs(ft) < 0.05) return 'at anchor';
  return ft > 0 ? `${ft.toFixed(1)} ft ${posLabel}` : `${(-ft).toFixed(1)} ft ${negLabel}`;
}

function CompartmentDetailPanel({
  mapId,
  comp,
  onMoved,
  onClose,
}: {
  mapId: number;
  comp: GreenhouseCompartmentDetail;
  onMoved: () => void;
  onClose: () => void;
}) {
  // ── Position from Anchor ────────────────────────────────────────────────
  const [ewDist, setEwDist] = useState(String(Math.abs(comp.xFt)));
  const [ewDir,  setEwDir]  = useState<'east' | 'west'>(comp.xFt >= 0 ? 'east' : 'west');
  const [nsDist, setNsDist] = useState(String(Math.abs(comp.yFt)));
  const [nsDir,  setNsDir]  = useState<'south' | 'north'>(comp.yFt >= 0 ? 'south' : 'north');
  const [applyErr, setApplyErr] = useState<string | null>(null);

  // ── Move Phase ──────────────────────────────────────────────────────────
  const [moveNorth, setMoveNorth] = useState('');
  const [moveSouth, setMoveSouth] = useState('');
  const [moveEast,  setMoveEast]  = useState('');
  const [moveWest,  setMoveWest]  = useState('');
  const [moveErr,   setMoveErr]   = useState<string | null>(null);

  // Sync position inputs when comp data refreshes
  useEffect(() => {
    setEwDist(String(Math.abs(comp.xFt)));
    setEwDir(comp.xFt >= 0 ? 'east' : 'west');
    setNsDist(String(Math.abs(comp.yFt)));
    setNsDir(comp.yFt >= 0 ? 'south' : 'north');
    setApplyErr(null);
  }, [comp.xFt, comp.yFt]);

  const applyMut = useMutation({
    mutationFn: () => {
      const d = parseFloat(ewDist), s = parseFloat(nsDist);
      if (isNaN(d) || d < 0 || isNaN(s) || s < 0) throw new Error('Enter valid positive distances');
      const xFt = ewDir === 'east' ? d : -d;
      const yFt = nsDir === 'south' ? s : -s;
      return greenhouseApi.updateCompartment(mapId, comp.id, { xFt, yFt });
    },
    onSuccess: () => { setApplyErr(null); onMoved(); },
    onError: (e: Error) => setApplyErr(e.message),
  });

  const resetMut = useMutation({
    mutationFn: () => greenhouseApi.updateCompartment(mapId, comp.id, { xFt: 0, yFt: 0 }),
    onSuccess: onMoved,
    onError: (e: Error) => setApplyErr(e.message),
  });

  const moveMut = useMutation({
    mutationFn: ({ dx, dy }: { dx: number; dy: number }) =>
      greenhouseApi.updateCompartment(mapId, comp.id, { xFt: comp.xFt + dx, yFt: comp.yFt + dy }),
    onSuccess: () => { setMoveErr(null); onMoved(); },
    onError: (e: Error) => setMoveErr(e.message),
  });

  function doMove(dx: number, dy: number) {
    setMoveErr(null);
    moveMut.mutate({ dx, dy });
  }

  function parseDist(val: string, label: string): number {
    const n = parseFloat(val);
    if (isNaN(n) || n <= 0) throw new Error(`Enter a positive number for ${label}`);
    return n;
  }

  const dirBtn = (active: boolean, label: string, onClick: () => void) => (
    <button type="button" onClick={onClick}
      className={`px-2.5 py-1 text-xs rounded border transition-colors font-medium ${
        active ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'
      }`}>
      {label}
    </button>
  );

  const curXFt = comp.xFt;
  const curYFt = comp.yFt;

  return (
    <div className="absolute right-0 top-0 bottom-0 w-64 bg-white border-l border-gray-200 flex flex-col overflow-y-auto z-10 shadow-lg">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900 truncate">{comp.name}</p>
          <p className="text-[10px] text-gray-400 mt-0.5">{comp.eastWestFt} ft E↔W · {comp.northSouthFt} ft N↕S</p>
        </div>
        <button onClick={onClose} className="ml-2 flex-shrink-0 text-gray-400 hover:text-gray-600"><X size={14} /></button>
      </div>

      {/* ── POSITION FROM ANCHOR ── */}
      <div className="px-4 py-4 border-b border-gray-100 space-y-3">
        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Position from Anchor</p>

        {/* Current position summary */}
        <div className="rounded-lg bg-gray-50 px-3 py-2.5 space-y-1">
          <div className="flex items-baseline justify-between">
            <span className="text-[10px] text-gray-400">Horizontal</span>
            <span className="text-xs font-semibold text-gray-700">{fmtDist(curXFt, 'East', 'West')}</span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-[10px] text-gray-400">Vertical</span>
            <span className="text-xs font-semibold text-gray-700">{fmtDist(curYFt, 'South', 'North')}</span>
          </div>
        </div>

        {/* E/W input */}
        <div>
          <label className="block text-[10px] text-gray-400 mb-1">East / West</label>
          <div className="flex gap-1 mb-1">
            {dirBtn(ewDir === 'east', 'East', () => setEwDir('east'))}
            {dirBtn(ewDir === 'west', 'West', () => setEwDir('west'))}
          </div>
          <div className="flex items-center gap-1.5">
            <input type="number" min={0} value={ewDist}
              onChange={e => { setEwDist(e.target.value); setApplyErr(null); }}
              onKeyDown={e => { if (e.key === 'Enter') applyMut.mutate(); }}
              className={inputCls + ' text-xs py-1.5 flex-1'} placeholder="0" />
            <span className="text-[10px] text-gray-400 whitespace-nowrap">ft</span>
          </div>
        </div>

        {/* N/S input */}
        <div>
          <label className="block text-[10px] text-gray-400 mb-1">North / South</label>
          <div className="flex gap-1 mb-1">
            {dirBtn(nsDir === 'north', 'North', () => setNsDir('north'))}
            {dirBtn(nsDir === 'south', 'South', () => setNsDir('south'))}
          </div>
          <div className="flex items-center gap-1.5">
            <input type="number" min={0} value={nsDist}
              onChange={e => { setNsDist(e.target.value); setApplyErr(null); }}
              onKeyDown={e => { if (e.key === 'Enter') applyMut.mutate(); }}
              className={inputCls + ' text-xs py-1.5 flex-1'} placeholder="0" />
            <span className="text-[10px] text-gray-400 whitespace-nowrap">ft</span>
          </div>
        </div>

        {applyErr && <p className="text-[10px] text-red-600">{applyErr}</p>}

        <div className="flex gap-2">
          <button onClick={() => applyMut.mutate()} disabled={applyMut.isPending || resetMut.isPending}
            className="flex-1 px-3 py-1.5 text-xs font-medium text-white bg-emerald-600 rounded-md hover:bg-emerald-700 disabled:opacity-50 transition-colors">
            {applyMut.isPending ? 'Applying…' : 'Apply Position'}
          </button>
          <button onClick={() => resetMut.mutate()} disabled={applyMut.isPending || resetMut.isPending}
            className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 rounded-md hover:bg-gray-200 disabled:opacity-50 transition-colors whitespace-nowrap">
            {resetMut.isPending ? '…' : 'Reset'}
          </button>
        </div>
        <p className="text-[10px] text-gray-400">Reset moves the phase to the anchor (0, 0).</p>
      </div>

      {/* ── MOVE PHASE ── */}
      <div className="px-4 py-4 space-y-2.5">
        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Move Phase</p>
        <p className="text-[10px] text-gray-400 -mt-1">Moves relative to current position.</p>

        {[
          { label: 'North', icon: <ArrowUp size={11} />, action: (v: number) => doMove(0, -v) },
          { label: 'South', icon: <ArrowDown size={11} />, action: (v: number) => doMove(0,  v) },
          { label: 'East',  icon: <ArrowEast size={11} />, action: (v: number) => doMove( v, 0) },
          { label: 'West',  icon: <ArrowWest size={11} />, action: (v: number) => doMove(-v, 0) },
        ].map(({ label, icon, action }) => {
          const [val, setVal] = label === 'North' ? [moveNorth, setMoveNorth]
            : label === 'South' ? [moveSouth, setMoveSouth]
            : label === 'East'  ? [moveEast,  setMoveEast]
            :                     [moveWest,   setMoveWest];
          return (
            <div key={label} className="flex items-center gap-2">
              <span className="w-9 text-xs text-gray-500 font-medium">{label}</span>
              <input type="number" min={0} value={val}
                onChange={e => { setVal(e.target.value); setMoveErr(null); }}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    try { action(parseDist(val, label)); }
                    catch (err) { setMoveErr((err as Error).message); }
                  }
                }}
                className={inputCls + ' text-xs py-1 flex-1'} placeholder="ft" />
              <button
                onClick={() => {
                  try { action(parseDist(val, label)); }
                  catch (err) { setMoveErr((err as Error).message); }
                }}
                disabled={moveMut.isPending}
                className="flex items-center gap-1 px-2 py-1 text-xs text-white bg-gray-700 rounded hover:bg-gray-800 disabled:opacity-50 transition-colors whitespace-nowrap">
                {icon} Move
              </button>
            </div>
          );
        })}

        {moveErr && <p className="text-[10px] text-red-600">{moveErr}</p>}
      </div>
    </div>
  );
}

// ── Canvas Setup panel ────────────────────────────────────────────────────────

function CanvasSetupPanel({
  mapId,
  northExtentFt,
  southExtentFt,
  eastExtentFt,
  westExtentFt,
  onSaved,
  onClose,
}: {
  mapId: number;
  northExtentFt: number;
  southExtentFt: number;
  eastExtentFt: number;
  westExtentFt: number;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [north, setNorth] = useState(String(northExtentFt));
  const [south, setSouth] = useState(String(southExtentFt));
  const [east,  setEast]  = useState(String(eastExtentFt));
  const [west,  setWest]  = useState(String(westExtentFt));
  const [err,   setErr]   = useState<string | null>(null);

  useEffect(() => {
    setNorth(String(northExtentFt));
    setSouth(String(southExtentFt));
    setEast(String(eastExtentFt));
    setWest(String(westExtentFt));
  }, [northExtentFt, southExtentFt, eastExtentFt, westExtentFt]);

  const mut = useMutation({
    mutationFn: () => {
      const n = parseFloat(north), s = parseFloat(south), e = parseFloat(east), w = parseFloat(west);
      if ([n, s, e, w].some(isNaN) || [n, s, e, w].some(v => v <= 0)) throw new Error('All extents must be positive numbers');
      return greenhouseApi.updateMap(mapId, { northExtentFt: n, southExtentFt: s, eastExtentFt: e, westExtentFt: w });
    },
    onSuccess: () => { onSaved(); onClose(); },
    onError: (e: Error) => setErr(e.message),
  });

  const numInput = (label: string, value: string, onChange: (v: string) => void) => (
    <div>
      <label className="block text-[10px] text-gray-400 mb-0.5">{label}</label>
      <div className="flex items-center gap-1">
        <input
          type="number" min={1} value={value}
          onChange={ev => { onChange(ev.target.value); setErr(null); }}
          className={inputCls + ' text-xs py-1.5'}
        />
        <span className="text-xs text-gray-400 whitespace-nowrap">ft</span>
      </div>
    </div>
  );

  return (
    <div className="absolute inset-0 bg-black/30 flex items-center justify-center z-20">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-xs mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Canvas Size</h3>
            <p className="text-xs text-gray-400 mt-0.5">Distance from anchor (0, 0) in each direction</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={15} /></button>
        </div>
        <div className="px-4 py-4 space-y-3">
          {numInput('North extent — how far canvas reaches North of anchor', north, setNorth)}
          {numInput('South extent — how far canvas reaches South of anchor', south, setSouth)}
          {numInput('East extent — how far canvas reaches East of anchor',  east,  setEast)}
          {numInput('West extent — how far canvas reaches West of anchor',  west,  setWest)}
          {err && <p className="text-xs text-red-600">{err}</p>}
          <div className="flex gap-2 pt-1">
            <button
              onClick={() => mut.mutate()}
              disabled={mut.isPending}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-md hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              <Check size={13} />
              {mut.isPending ? 'Saving…' : 'Save'}
            </button>
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main builder ───────────────────────────────────────────────────────────────

const SNAP_OPTS = [{ label: 'Off', value: 0 }, { label: '1 ft', value: 1 }, { label: '5 ft', value: 5 }, { label: '10 ft', value: 10 }];

function Builder({ mapId }: { mapId: number }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const canvasRef = useRef<GreenhouseCanvasHandle>(null);
  const [selectedCompId, setSelectedCompId] = useState<number | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<number | null>(null);
  const [activePanel, setActivePanel] = useState<'addRows' | 'blockDetail' | 'compDetail' | null>(null);
  const [snapGridFt, setSnapGridFt] = useState(0);
  const [showCanvasSetup, setShowCanvasSetup] = useState(false);
  const [showAddComp, setShowAddComp] = useState(false);
  const [compartmentsOpen, setCompartmentsOpen] = useState(true);
  const { data: map, isLoading, isError } = useQuery({
    queryKey: ['greenhouse-map', mapId],
    queryFn: () => greenhouseApi.getMap(mapId),
  });

  useEffect(() => {
    if (map && map.compartments.length > 0 && selectedCompId == null) {
      setSelectedCompId(map.compartments[0].id);
    }
  }, [map?.id]);

  const deleteCompMut = useMutation({
    mutationFn: (id: number) => greenhouseApi.deleteCompartment(mapId, id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['greenhouse-map', mapId] });
      void qc.invalidateQueries({ queryKey: ['greenhouse-maps'] });
      setSelectedCompId(null);
      setSelectedBlockId(null);
      setActivePanel(null);
    },
  });

  const selectedComp = map?.compartments.find((c) => c.id === selectedCompId) ?? null;

  function handleCompCreated(comp: GreenhouseCompartmentDetail) {
    void qc.invalidateQueries({ queryKey: ['greenhouse-map', mapId] });
    void qc.invalidateQueries({ queryKey: ['greenhouse-maps'] });
    setShowAddComp(false);
    setSelectedCompId(comp.id);
  }

  function handleBlocksChanged() {
    void qc.invalidateQueries({ queryKey: ['greenhouse-map', mapId] });
    void qc.invalidateQueries({ queryKey: ['greenhouse-maps'] });
    void qc.invalidateQueries({ queryKey: ['locations'] });
  }

  const deleteRowsMut = useMutation({
    mutationFn: (ids: number[]) => greenhouseApi.bulkDeleteRows(mapId, ids),
    onSuccess: () => {
      handleBlocksChanged();
    },
  });

  function handleDeleteSelected(ids: Set<number>) {
    const n = ids.size;
    if (!confirm(`Delete ${n} selected row${n === 1 ? '' : 's'}? This cannot be undone.`)) return;
    deleteRowsMut.mutate([...ids]);
  }

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-gray-400">Loading…</div>
    );
  }
  if (isError || !map) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-sm">
        <p className="text-gray-500">Map not found.</p>
        <button
          onClick={() => navigate('/greenhouse')}
          className="text-xs text-emerald-600 hover:text-emerald-700 font-medium underline"
        >
          ← Back to Greenhouse
        </button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 px-5 py-3 bg-white border-b border-gray-200 flex items-center gap-3">
        <button
          onClick={() => navigate('/greenhouse')}
          className="text-gray-400 hover:text-gray-600 transition-colors"
        >
          <ArrowLeft size={16} />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold text-gray-900 truncate">{map.name}</h1>
          <p className="text-xs text-gray-400">{map.siteName}</p>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left sidebar */}
        <aside className="w-56 flex-shrink-0 flex flex-col border-r border-gray-200 bg-white overflow-y-auto">
          {/* Compartments section */}
          <div>
            <button
              onClick={() => setCompartmentsOpen((o) => !o)}
              className="w-full flex items-center justify-between px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider hover:bg-gray-50 transition-colors"
            >
              <span>Compartments</span>
              {compartmentsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>

            {compartmentsOpen && (
              <>
                {map.compartments.length === 0 && (
                  <p className="px-4 py-2 text-xs text-gray-400">None yet</p>
                )}
                {map.compartments.map((comp) => {
                  const isSelected = comp.id === selectedCompId;
                  return (
                    <button
                      key={comp.id}
                      onClick={() => {
                        setSelectedCompId(comp.id);
                        setSelectedBlockId(null);
                        setActivePanel(null);
                      }}
                      className={`w-full text-left px-4 py-2.5 border-l-2 transition-colors ${
                        isSelected
                          ? 'bg-emerald-50 border-emerald-500'
                          : 'border-transparent hover:bg-gray-50'
                      }`}
                    >
                      <p className="text-sm font-medium text-gray-900 truncate">{comp.name}</p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {comp.eastWestFt} ft E↔W · {comp.northSouthFt} ft N↕S · {comp.blocks.flatMap(b => b.rows).length} rows
                      </p>
                    </button>
                  );
                })}

                {/* Add compartment button / form */}
                {showAddComp ? (
                  <AddCompartmentForm
                    mapId={mapId}
                    onCreated={handleCompCreated}
                    onCancel={() => setShowAddComp(false)}
                  />
                ) : (
                  <button
                    onClick={() => setShowAddComp(true)}
                    className="w-full flex items-center gap-2 px-4 py-2.5 text-xs text-gray-500 hover:text-emerald-700 hover:bg-emerald-50 transition-colors"
                  >
                    <Plus size={12} />
                    Add Compartment
                  </button>
                )}
              </>
            )}
          </div>

          {/* Selected compartment actions */}
          {selectedComp && (
            <div className="mt-auto border-t border-gray-100 p-3 space-y-1.5">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider px-1 mb-2">
                {selectedComp.name}
              </p>
              <button
                onClick={() => { setSelectedBlockId(null); setActivePanel('addRows'); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-emerald-700 bg-emerald-50 rounded-md hover:bg-emerald-100 transition-colors"
              >
                <Rows3 size={13} />
                Add Row Block
              </button>
              <button
                onClick={() => {
                  if (confirm(`Delete compartment "${selectedComp.name}" and all its rows?`)) {
                    deleteCompMut.mutate(selectedComp.id);
                  }
                }}
                disabled={deleteCompMut.isPending}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50 rounded-md transition-colors disabled:opacity-50"
              >
                <Trash2 size={13} />
                Delete Compartment
              </button>
            </div>
          )}
        </aside>

        {/* Canvas area */}
        <div className="flex-1 relative flex flex-col overflow-hidden">
          {/* Toolbar */}
          <div className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-white border-b border-gray-100">
            <Grid3X3 size={12} className="text-gray-400" />
            <span className="text-xs text-gray-400 mr-1">Snap:</span>
            {SNAP_OPTS.map(opt => (
              <button
                key={opt.value}
                onClick={() => setSnapGridFt(opt.value)}
                className={`px-2 py-0.5 text-xs rounded transition-colors ${
                  snapGridFt === opt.value
                    ? 'bg-blue-600 text-white font-semibold'
                    : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                }`}
              >
                {opt.label}
              </button>
            ))}

            <div className="ml-auto flex items-center gap-1">
              {/* Fit All */}
              <button
                onClick={() => canvasRef.current?.fitCompartments()}
                title="Fit all compartments into view"
                className="flex items-center gap-1 px-2 py-0.5 text-xs text-gray-500 hover:bg-gray-100 rounded transition-colors"
              >
                <Scan size={11} />
                Fit All
              </button>

              {/* Canvas Size */}
              <button
                onClick={() => setShowCanvasSetup(v => !v)}
                title="Set canvas size (extents from anchor)"
                className={`flex items-center gap-1 px-2 py-0.5 text-xs rounded transition-colors ${
                  showCanvasSetup ? 'bg-gray-200 text-gray-700' : 'text-gray-500 hover:bg-gray-100'
                }`}
              >
                <Settings2 size={11} />
                Canvas Size
              </button>

            </div>
          </div>

          <div className="flex-1 relative flex overflow-hidden">
            <GreenhouseCanvas
              ref={canvasRef}
              compartments={map.compartments}
              northExtentFt={map.northExtentFt}
              southExtentFt={map.southExtentFt}
              eastExtentFt={map.eastExtentFt}
              westExtentFt={map.westExtentFt}
              selectedCompartmentId={selectedCompId}
              selectedBlockId={selectedBlockId}
              snapGridFt={snapGridFt}
              onSelectCompartment={(id) => {
                setSelectedCompId(id);
                setSelectedBlockId(null);
                if (activePanel === 'blockDetail') setActivePanel(null);
              }}
              onSelectBlock={(blockId, compId) => {
                setSelectedCompId(compId);
                setSelectedBlockId(blockId);
                setActivePanel('blockDetail');
              }}
              onDeleteSelected={handleDeleteSelected}
              isDeleting={deleteRowsMut.isPending}
            />

            {activePanel === 'addRows' && selectedComp && (
              <RowBlockAddPanel
                mapId={mapId}
                compartment={selectedComp}
                onDone={handleBlocksChanged}
                onClose={() => setActivePanel(null)}
              />
            )}

            {activePanel === 'blockDetail' && selectedBlockId != null && selectedComp && (
              <BlockDetailPanel
                mapId={mapId}
                compartment={selectedComp}
                blockId={selectedBlockId}
                onDeleted={() => {
                  handleBlocksChanged();
                  setSelectedBlockId(null);
                  setActivePanel(null);
                }}
                onDone={handleBlocksChanged}
                onClose={() => { setSelectedBlockId(null); setActivePanel(null); }}
              />
            )}

            {/* Position panel — auto-shows when a compartment is selected */}
            {selectedComp && activePanel !== 'addRows' && activePanel !== 'blockDetail' && (
              <CompartmentDetailPanel
                mapId={mapId}
                comp={selectedComp}
                onMoved={() => void qc.invalidateQueries({ queryKey: ['greenhouse-map', mapId] })}
                onClose={() => setSelectedCompId(null)}
              />
            )}

            {showCanvasSetup && (
              <CanvasSetupPanel
                mapId={mapId}
                northExtentFt={map.northExtentFt}
                southExtentFt={map.southExtentFt}
                eastExtentFt={map.eastExtentFt}
                westExtentFt={map.westExtentFt}
                onSaved={() => void qc.invalidateQueries({ queryKey: ['greenhouse-map', mapId] })}
                onClose={() => setShowCanvasSetup(false)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Page entry point ───────────────────────────────────────────────────────────

export function GreenhouseMapBuilderPage() {
  const { mapId } = useParams<{ mapId: string }>();

  if (mapId === 'new') return <NewMapForm />;
  if (!mapId || isNaN(Number(mapId))) return <NewMapForm />;

  return <Builder mapId={Number(mapId)} />;
}
