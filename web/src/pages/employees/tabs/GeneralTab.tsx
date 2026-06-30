import type { MockEmployee } from '../mock-data';
import { Section, Field, formatDateLong } from '../helpers';

interface Props {
  employee: MockEmployee;
}

export function GeneralTab({ employee }: Props) {
  return (
    <div className="px-8 py-6">
      <Section title="Personal Details">
        <div className="grid grid-cols-2 gap-x-8 gap-y-5">
          <Field label="First Name" value={employee.firstName} />
          <Field label="Last Name" value={employee.lastName} />
          <Field
            label="Date of Birth"
            value={employee.dateOfBirth ? formatDateLong(employee.dateOfBirth) : undefined}
          />
          <Field label="Employee Number" value={employee.employeeNumber} />
        </div>
      </Section>

      <Section title="Contact">
        <div className="grid grid-cols-2 gap-x-8 gap-y-5">
          <Field label="Phone" value={employee.phone} />
          <Field label="Email" value={employee.email} />
        </div>
      </Section>
    </div>
  );
}
