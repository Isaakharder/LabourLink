import type { Employee } from '../../../api/employees';
import { Section, Field, formatDateLong } from '../helpers';

interface Props {
  employee: Employee;
}

export function EmploymentTab({ employee }: Props) {
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
    </div>
  );
}
