import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Check, X, Star } from 'lucide-react';
import { locationApi } from '../../../api/locations';
import type { LocationDetail, LocationScanCode } from '../../../api/locations';

interface Props {
  location: LocationDetail;
}

const inputCls = 'px-3 py-2 text-sm border border-gray-200 rounded-md bg-white placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500';

export function ScanCodesTab({ location }: Props) {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [scanCode, setScanCode] = useState('');
  const [scanType, setScanType] = useState<string>('qr');
  const [label, setLabel] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  const { data: codes = [], isLoading } = useQuery({
    queryKey: ['location-scan-codes', location.id],
    queryFn: () => locationApi.scanCodes(location.id),
  });

  const createMut = useMutation({
    mutationFn: () =>
      locationApi.createScanCode({
        locationId: location.id,
        scanCode: scanCode.trim(),
        scanType,
        label: label.trim() || undefined,
        isPrimary,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['location-scan-codes', location.id] });
      setShowForm(false);
      setScanCode('');
      setLabel('');
      setIsPrimary(false);
      setFormErr(null);
    },
    onError: (err: Error) => setFormErr(err.message),
  });

  const archiveMut = useMutation({
    mutationFn: (id: number) =>
      locationApi.updateScanCode(id, { archivedAt: new Date().toISOString() }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['location-scan-codes', location.id] }),
  });

  const primaryMut = useMutation({
    mutationFn: (id: number) => locationApi.updateScanCode(id, { isPrimary: true }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['location-scan-codes', location.id] }),
  });

  const active   = codes.filter((c: LocationScanCode) => !c.archivedAt);
  const inactive = codes.filter((c: LocationScanCode) =>  c.archivedAt);

  return (
    <div className="px-8 py-6 max-w-xl">
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Scan Codes</p>
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center gap-1 text-xs text-emerald-700 hover:text-emerald-800 font-medium"
          >
            <Plus size={12} /> Add Code
          </button>
        )}
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : active.length === 0 && !showForm ? (
        <p className="text-sm text-gray-400">No scan codes yet.</p>
      ) : (
        <ul className="space-y-2 mb-4">
          {active.map((c: LocationScanCode) => (
            <li key={c.id} className="flex items-center justify-between bg-gray-50 border border-gray-200 rounded-md px-4 py-2.5">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-mono text-gray-900">{c.scanCode}</span>
                  {c.isPrimary && (
                    <Star size={11} className="text-amber-500 fill-amber-400" />
                  )}
                  <span className="text-xs text-gray-400 uppercase">{c.scanType}</span>
                </div>
                {c.label && <p className="text-xs text-gray-400 mt-0.5">{c.label}</p>}
              </div>
              <div className="flex items-center gap-2">
                {!c.isPrimary && (
                  <button
                    onClick={() => primaryMut.mutate(c.id)}
                    disabled={primaryMut.isPending}
                    className="text-xs text-gray-400 hover:text-amber-600 transition-colors"
                    title="Set as primary"
                  >
                    <Star size={13} />
                  </button>
                )}
                <button
                  onClick={() => archiveMut.mutate(c.id)}
                  disabled={archiveMut.isPending}
                  className="text-gray-400 hover:text-red-500 transition-colors"
                  title="Deactivate"
                >
                  <X size={14} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {showForm && (
        <div className="border border-gray-200 rounded-lg bg-white p-4 mb-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold text-gray-800">Add Scan Code</p>
            <button onClick={() => { setShowForm(false); setFormErr(null); }} className="text-gray-400 hover:text-gray-600">
              <X size={14} />
            </button>
          </div>
          <div className="space-y-3">
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Scan code value"
                value={scanCode}
                onChange={e => setScanCode(e.target.value)}
                className={`flex-1 ${inputCls}`}
              />
              <select value={scanType} onChange={e => setScanType(e.target.value)} className={inputCls}>
                <option value="qr">QR</option>
                <option value="rfid">RFID</option>
                <option value="barcode">Barcode</option>
                <option value="manual">Manual</option>
              </select>
            </div>
            <input
              type="text"
              placeholder="Label (optional)"
              value={label}
              onChange={e => setLabel(e.target.value)}
              className={`w-full ${inputCls}`}
            />
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={isPrimary}
                onChange={e => setIsPrimary(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
              />
              Set as primary
            </label>
          </div>
          {formErr && <p className="mt-2 text-sm text-red-600">{formErr}</p>}
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={() => createMut.mutate()}
              disabled={!scanCode.trim() || createMut.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 disabled:opacity-50"
            >
              <Check size={12} />
              {createMut.isPending ? 'Adding…' : 'Add'}
            </button>
          </div>
        </div>
      )}

      {inactive.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Inactive</p>
          <ul className="space-y-1">
            {inactive.map((c: LocationScanCode) => (
              <li key={c.id} className="flex items-center gap-2 text-xs text-gray-400 px-1">
                <span className="font-mono line-through">{c.scanCode}</span>
                <span className="uppercase">{c.scanType}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
