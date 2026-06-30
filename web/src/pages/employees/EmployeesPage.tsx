import { useState } from 'react';
import { MOCK_EMPLOYEES } from './mock-data';
import { EmployeeList } from './EmployeeList';
import { EmployeeDetail } from './EmployeeDetail';

export function EmployeesPage() {
  const [selectedId, setSelectedId] = useState<number | null>(MOCK_EMPLOYEES[0]?.id ?? null);
  const [isNew, setIsNew] = useState(false);

  const selected =
    selectedId != null ? (MOCK_EMPLOYEES.find(e => e.id === selectedId) ?? null) : null;

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
    if (MOCK_EMPLOYEES.length > 0) {
      setSelectedId(MOCK_EMPLOYEES[0].id);
    }
  }

  return (
    <div className="-m-8 h-full flex overflow-hidden">
      <EmployeeList
        employees={MOCK_EMPLOYEES}
        selectedId={selectedId}
        onSelect={handleSelect}
        onNew={handleNew}
      />
      <EmployeeDetail employee={selected} isNew={isNew} onCancelNew={handleCancelNew} />
    </div>
  );
}
