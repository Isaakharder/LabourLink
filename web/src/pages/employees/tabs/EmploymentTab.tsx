import type { MockEmployee } from '../mock-data';
import { Section, Field, formatDateLong } from '../helpers';

interface Props {
  employee: MockEmployee;
}

export function EmploymentTab({ employee }: Props) {
  return (
    <div className="px-8 py-6">
      <Section title="Current Employment Record">
        <div className="grid grid-cols-2 gap-x-8 gap-y-5">
          <Field label="Site" value={employee.site} />
          <Field label="Contract" value={employee.contract} />
          <Field label="Job Role" value={employee.jobRole} />
          <Field label="Team" value={employee.team} />
          <Field label="Supervisor" value={employee.supervisor} />
          <Field label="Start Date" value={formatDateLong(employee.employmentStartDate)} />
        </div>
      </Section>
    </div>
  );
}
