import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { keepPreviousData } from '@tanstack/react-query';
import { contractApi } from '../../api/contracts';
import { ContractList } from './ContractList';
import { ContractDetail } from './ContractDetail';
import { NewContractForm } from './NewContractForm';

export function ContractsPage() {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [isNew, setIsNew] = useState(false);
  const qc = useQueryClient();

  const { data: contracts = [], isLoading } = useQuery({
    queryKey: ['contracts'],
    queryFn: contractApi.list,
  });

  useEffect(() => {
    if (contracts.length > 0 && selectedId === null && !isNew) {
      setSelectedId(contracts[0].id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contracts.length]);

  const activeId = isNew ? null : selectedId;

  const { data: detail } = useQuery({
    queryKey: ['contract', activeId],
    queryFn: () => contractApi.detail(activeId!),
    enabled: activeId !== null,
    placeholderData: keepPreviousData,
  });

  function handleSelect(id: number) { setSelectedId(id); setIsNew(false); }
  function handleNew() { setSelectedId(null); setIsNew(true); }
  function handleCancelNew() { setIsNew(false); if (contracts.length > 0) setSelectedId(contracts[0].id); }

  function handleCreated(id: number) {
    void qc.invalidateQueries({ queryKey: ['contracts'] });
    setIsNew(false);
    setSelectedId(id);
  }

  function handleUpdated() {
    void qc.invalidateQueries({ queryKey: ['contracts'] });
    if (selectedId !== null) void qc.invalidateQueries({ queryKey: ['contract', selectedId] });
  }

  return (
    <div className="-m-8 h-full flex overflow-hidden">
      <ContractList
        contracts={contracts}
        isLoading={isLoading}
        selectedId={selectedId}
        isNew={isNew}
        onSelect={handleSelect}
        onNew={handleNew}
      />
      {isNew ? (
        <NewContractForm onCreated={handleCreated} onCancel={handleCancelNew} />
      ) : (
        <ContractDetail
          contract={detail ?? null}
          onUpdated={handleUpdated}
        />
      )}
    </div>
  );
}
