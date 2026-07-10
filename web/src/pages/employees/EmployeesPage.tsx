import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { keepPreviousData } from '@tanstack/react-query';
import { employeeApi } from '../../api/employees';
import { EmployeeList } from './EmployeeList';
import { EmployeeDetail } from './EmployeeDetail';
import { useAuth } from '@/lib/AuthContext';

export function EmployeesPage() {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [isNew, setIsNew] = useState(false);
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();

  const { data: employees = [], isLoading: isListLoading } = useQuery({
    queryKey: ['employees'],
    queryFn: employeeApi.list,
  });

  // Select the first employee once the list loads (only if nothing is selected)
  useEffect(() => {
    if (employees.length > 0 && selectedId === null && !isNew) {
      setSelectedId(employees[0].id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employees.length]);

  const activeId = isNew ? null : selectedId;

  const { data: selectedEmployee } = useQuery({
    queryKey: ['employee', activeId],
    queryFn: () => employeeApi.detail(activeId!),
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
    if (employees.length > 0) {
      setSelectedId(employees[0].id);
    }
  }

  function handleCreated(id: number) {
    void queryClient.invalidateQueries({ queryKey: ['employees'] });
    setIsNew(false);
    setSelectedId(id);
  }

  return (
    <div className="-m-8 h-full flex overflow-hidden">
      <EmployeeList
        employees={employees}
        isLoading={isListLoading}
        selectedId={selectedId}
        onSelect={handleSelect}
        onNew={handleNew}
        canCreate={hasPermission('employees:edit')}
      />
      <EmployeeDetail
        employee={selectedEmployee ?? null}
        isNew={isNew}
        onCancelNew={handleCancelNew}
        onCreated={handleCreated}
      />
    </div>
  );
}
