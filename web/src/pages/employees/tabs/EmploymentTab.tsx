import { useState, useEffect } from 'react';
import { ChevronDown, Check, X, AlertCircle } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Employee } from '../../../api/employees';
import { employeeApi } from '../../../api/employees';
import { Section, Field, formatDateLong } from '../helpers';
import { contractApi } from '../../../api/contracts';

interface Props {
  employee: Employee;
}

const inputCls = 'w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500';

export function EmploymentTab({ employee }: Props) {
  const qc = useQueryClient();
  const [showChange, setShowChange] = useState(false);
  const [contractId, setContractId] = useState('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [notes, setNotes] = useState('Contract Change');

  // Reset form when employee changes
  useEffect(() => {
    setShowChange(false);
    setContractId('');
    setEffectiveDate('');
    setNotes('Contract Change');
  }, [employee.id]);

  const { data: contracts = [] } = useQuery({
    queryKey: ['contracts'],
    queryFn: contractApi.list,
    enabled: showChange,
  });

  const changeMutation = useMutation({
    mutationFn: () =>
      employeeApi.changeContract(employee.id, {
        contractTemplateId: parseInt(contractId, 10),
        effectiveDate,
        notes,
      }),
    onSuccess: () => {
      setShowChange(false);
      // Invalidate employee detail so the contract name refreshes
      void qc.invalidateQueries({ queryKey: ['employee', employee.id] });
      void qc.invalidateQueries({ queryKey: ['employees'] });
    },
  });

  const activeContracts = contracts.filter(c => !c.archivedAt);
  const canSubmit = contractId && effectiveDate && !changeMutation.isPending;

  return (
    <div className="px-8 py-6">
      <Section title="Current Employment Record">
        <div className="grid grid-cols-2 gap-x-8 gap-y-5">
          <Field label="Site"       value={employee.site       ?? undefined} />
          <Field label="Contract"   value={employee.contract   ?? undefined} />
          <Field label="Job Role"   value={employee.jobRole    ?? undefined} />
          <Field label="Team"       value={employee.team       ?? undefined} />
          <Field label="Supervisor" value={employee.supervisor ?? undefined} />
          <Field
            label="Start Date"
            value={employee.employmentStartDate ? formatDateLong(employee.employmentStartDate) : undefined}
          />
        </div>
      </Section>

      {/* Change Contract section */}
      <div className="mt-4">
        {!showChange ? (
          <button
            onClick={() => setShowChange(true)}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 border border-gray-200 rounded-md px-3 py-1.5 hover:bg-gray-50 transition-colors"
          >
            <ChevronDown size={14} /> Change Contract
          </button>
        ) : (
          <div className="border border-gray-200 rounded-lg bg-white p-5 max-w-md">
            <div className="flex items-center justify-between mb-4">
              <h4 className="text-sm font-semibold text-gray-800">Change Contract</h4>
              <button
                onClick={() => setShowChange(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                <X size={15} />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  New Contract <span className="text-red-500">*</span>
                </label>
                <select
                  value={contractId}
                  onChange={e => setContractId(e.target.value)}
                  className={inputCls}
                >
                  <option value="">Select contract…</option>
                  {activeContracts.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Effective Date <span className="text-red-500">*</span>
                </label>
                <input
                  type="date"
                  value={effectiveDate}
                  onChange={e => setEffectiveDate(e.target.value)}
                  className={inputCls}
                />
                <p className="text-xs text-gray-400 mt-1">
                  The current contract record will end the day before this date.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Reason</label>
                <input
                  type="text"
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  className={inputCls}
                />
              </div>
            </div>

            {changeMutation.isError && (
              <p className="mt-3 text-sm text-red-600 flex items-center gap-1.5">
                <AlertCircle size={14} />
                {changeMutation.error instanceof Error ? changeMutation.error.message : 'Failed'}
              </p>
            )}

            <div className="mt-4 flex items-center gap-3">
              <button
                onClick={() => changeMutation.mutate()}
                disabled={!canSubmit}
                className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Check size={13} />
                {changeMutation.isPending ? 'Saving…' : 'Apply Change'}
              </button>
              <button
                onClick={() => setShowChange(false)}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
