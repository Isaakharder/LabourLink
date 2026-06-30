import { Smartphone } from 'lucide-react';
import type { Employee, DeviceRecord } from '../../../api/employees';
import { formatDate } from '../helpers';

interface Props {
  employee: Employee;
}

export function DevicesTab({ employee }: Props) {
  const current = employee.devices.filter(d => !d.assignedUntil);
  const past    = employee.devices.filter(d => !!d.assignedUntil);

  if (employee.devices.length === 0) {
    return (
      <div className="px-8 py-6">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
          Assigned Devices
        </h3>
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center">
          <Smartphone size={24} className="mx-auto text-gray-300 mb-2" />
          <p className="text-sm text-gray-400">No devices assigned</p>
        </div>
      </div>
    );
  }

  return (
    <div className="px-8 py-6">
      {current.length > 0 && (
        <>
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
            Assigned Devices
          </h3>
          <div className="space-y-3 mb-6">
            {current.map(d => <DeviceRow key={d.id} device={d} isCurrent />)}
          </div>
        </>
      )}

      {past.length > 0 && (
        <>
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
            Past Assignments
          </h3>
          <div className="space-y-3">
            {past.map(d => <DeviceRow key={d.id} device={d} isCurrent={false} />)}
          </div>
        </>
      )}
    </div>
  );
}

function DeviceRow({ device, isCurrent }: { device: DeviceRecord; isCurrent: boolean }) {
  return (
    <div
      className={`bg-white rounded-lg border p-4 flex items-start gap-3 ${
        isCurrent ? 'border-gray-200' : 'border-gray-100 opacity-60'
      }`}
    >
      <Smartphone
        size={16}
        className={`mt-0.5 flex-shrink-0 ${isCurrent ? 'text-emerald-600' : 'text-gray-400'}`}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-gray-800">{device.name}</span>
          {device.isShared && (
            <span className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">Shared</span>
          )}
          {isCurrent && (
            <span className="text-xs bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded">
              Current
            </span>
          )}
        </div>
        <div className="mt-0.5 text-xs text-gray-400 font-mono">{device.identifier}</div>
        <div className="mt-1 text-xs text-gray-400">
          Since {formatDate(device.assignedSince)}
          {device.assignedUntil && ` · Until ${formatDate(device.assignedUntil)}`}
        </div>
      </div>
    </div>
  );
}
