export type EmployeeStatus = 'active' | 'inactive' | 'archived';
export type TabId =
  | 'general'
  | 'employment'
  | 'career'
  | 'security'
  | 'devices'
  | 'notes'
  | 'timeline';

export interface CareerRecord {
  id: number;
  site: string;
  jobRole: string;
  contract: string;
  team?: string;
  supervisor?: string;
  startedOn: string;
  endedOn?: string;
}

export interface DeviceRecord {
  id: number;
  name: string;
  identifier: string;
  isShared: boolean;
  assignedSince: string;
  assignedUntil?: string;
}

export interface TimelineEvent {
  id: number;
  date: string;
  type: 'employment' | 'contract' | 'security' | 'device' | 'archive' | 'note';
  description: string;
  performedBy?: string;
}

export interface MockEmployee {
  id: number;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  status: EmployeeStatus;
  dateOfBirth?: string;
  phone?: string;
  email?: string;
  site: string;
  contract: string;
  jobRole: string;
  team?: string;
  supervisor?: string;
  employmentStartDate: string;
  securityRole: string;
  hasPin: boolean;
  lastLoginAt?: string;
  careerHistory: CareerRecord[];
  devices: DeviceRecord[];
  notes: string;
  timeline: TimelineEvent[];
}

export const MOCK_EMPLOYEES: MockEmployee[] = [
  {
    id: 1,
    employeeNumber: 'EMP-0001',
    firstName: 'Jan',
    lastName: 'van der Berg',
    status: 'active',
    dateOfBirth: '1985-03-14',
    phone: '+31 6 12345678',
    email: 'jan.vandenberg@example.com',
    site: 'Greenhouse A',
    contract: 'Harvester Contract',
    jobRole: 'Harvester',
    team: 'Team Alpha',
    supervisor: 'Lisa Chen',
    employmentStartDate: '2019-01-07',
    securityRole: 'General',
    hasPin: true,
    lastLoginAt: '2026-06-28T07:23:00Z',
    careerHistory: [
      {
        id: 1,
        site: 'Greenhouse A',
        jobRole: 'Harvester',
        contract: 'Harvester Contract',
        team: 'Team Alpha',
        supervisor: 'Lisa Chen',
        startedOn: '2019-01-07',
      },
    ],
    devices: [
      {
        id: 1,
        name: 'Phone A-01',
        identifier: 'LL-A1B2C3D4',
        isShared: false,
        assignedSince: '2019-01-07',
      },
    ],
    notes: 'Reliable and experienced harvester. Completed first aid training in March 2024.',
    timeline: [
      {
        id: 1,
        date: '2019-01-07',
        type: 'employment',
        description: 'Joined as Harvester at Greenhouse A',
        performedBy: 'Thomas Müller',
      },
      {
        id: 2,
        date: '2019-01-07',
        type: 'device',
        description: 'Assigned device Phone A-01',
        performedBy: 'Thomas Müller',
      },
      {
        id: 3,
        date: '2024-03-15',
        type: 'note',
        description: 'Completed first aid certification',
      },
    ],
  },
  {
    id: 2,
    employeeNumber: 'EMP-0002',
    firstName: 'Maria',
    lastName: 'Santos',
    status: 'active',
    dateOfBirth: '1992-07-22',
    phone: '+31 6 23456789',
    email: 'maria.santos@example.com',
    site: 'Greenhouse A',
    contract: 'Packer Contract',
    jobRole: 'Packer',
    team: 'Team Beta',
    supervisor: 'Lisa Chen',
    employmentStartDate: '2021-03-15',
    securityRole: 'General',
    hasPin: true,
    lastLoginAt: '2026-06-28T06:45:00Z',
    careerHistory: [
      {
        id: 2,
        site: 'Greenhouse A',
        jobRole: 'General',
        contract: 'General Contract',
        team: 'Team Beta',
        startedOn: '2021-03-15',
        endedOn: '2022-06-30',
      },
      {
        id: 3,
        site: 'Greenhouse A',
        jobRole: 'Packer',
        contract: 'Packer Contract',
        team: 'Team Beta',
        supervisor: 'Lisa Chen',
        startedOn: '2022-07-01',
      },
    ],
    devices: [],
    notes: '',
    timeline: [
      {
        id: 4,
        date: '2021-03-15',
        type: 'employment',
        description: 'Joined as General at Greenhouse A',
        performedBy: 'Thomas Müller',
      },
      {
        id: 5,
        date: '2022-07-01',
        type: 'employment',
        description: 'Role changed to Packer',
        performedBy: 'Lisa Chen',
      },
      {
        id: 6,
        date: '2022-07-01',
        type: 'contract',
        description: 'Contract changed to Packer Contract',
        performedBy: 'Lisa Chen',
      },
    ],
  },
  {
    id: 3,
    employeeNumber: 'EMP-0003',
    firstName: 'Peter',
    lastName: 'Kowalski',
    status: 'active',
    dateOfBirth: '1979-11-30',
    phone: '+31 6 34567890',
    site: 'Greenhouse B',
    contract: 'General Contract',
    jobRole: 'Driver',
    employmentStartDate: '2017-08-21',
    securityRole: 'Crew Leader',
    hasPin: true,
    lastLoginAt: '2026-06-27T16:02:00Z',
    careerHistory: [
      {
        id: 4,
        site: 'Greenhouse B',
        jobRole: 'Driver',
        contract: 'General Contract',
        startedOn: '2017-08-21',
      },
    ],
    devices: [
      {
        id: 2,
        name: 'Phone B-03',
        identifier: 'LL-E5F6G7H8',
        isShared: false,
        assignedSince: '2020-01-10',
      },
    ],
    notes: 'Responsible for transport between Greenhouse A and B. Holds HGV licence class CE.',
    timeline: [
      {
        id: 7,
        date: '2017-08-21',
        type: 'employment',
        description: 'Joined as Driver at Greenhouse B',
        performedBy: 'Thomas Müller',
      },
      {
        id: 8,
        date: '2020-01-10',
        type: 'device',
        description: 'Assigned device Phone B-03',
        performedBy: 'Thomas Müller',
      },
      {
        id: 9,
        date: '2023-03-01',
        type: 'security',
        description: 'Security role upgraded to Crew Leader',
        performedBy: 'Thomas Müller',
      },
    ],
  },
  {
    id: 4,
    employeeNumber: 'EMP-0004',
    firstName: 'Lisa',
    lastName: 'Chen',
    status: 'active',
    dateOfBirth: '1988-05-03',
    phone: '+31 6 45678901',
    email: 'lisa.chen@labourlink.local',
    site: 'Greenhouse A',
    contract: 'Supervisor Contract',
    jobRole: 'Supervisor',
    employmentStartDate: '2018-04-09',
    securityRole: 'Supervisor',
    hasPin: true,
    lastLoginAt: '2026-06-29T08:05:00Z',
    careerHistory: [
      {
        id: 5,
        site: 'Greenhouse A',
        jobRole: 'Harvester',
        contract: 'Harvester Contract',
        team: 'Team Alpha',
        startedOn: '2018-04-09',
        endedOn: '2020-12-31',
      },
      {
        id: 6,
        site: 'Greenhouse A',
        jobRole: 'Supervisor',
        contract: 'Supervisor Contract',
        startedOn: '2021-01-01',
      },
    ],
    devices: [
      {
        id: 3,
        name: 'Tablet A-01',
        identifier: 'LL-I9J0K1L2',
        isShared: false,
        assignedSince: '2021-01-01',
      },
    ],
    notes:
      'Supervises Teams Alpha and Beta at Greenhouse A. Primary contact for new employee onboarding.',
    timeline: [
      {
        id: 10,
        date: '2018-04-09',
        type: 'employment',
        description: 'Joined as Harvester at Greenhouse A',
        performedBy: 'Thomas Müller',
      },
      {
        id: 11,
        date: '2021-01-01',
        type: 'employment',
        description: 'Promoted to Supervisor',
        performedBy: 'Thomas Müller',
      },
      {
        id: 12,
        date: '2021-01-01',
        type: 'security',
        description: 'Security role set to Supervisor',
        performedBy: 'Thomas Müller',
      },
      {
        id: 13,
        date: '2021-01-01',
        type: 'device',
        description: 'Assigned Tablet A-01',
        performedBy: 'Thomas Müller',
      },
    ],
  },
  {
    id: 5,
    employeeNumber: 'EMP-0005',
    firstName: 'Ahmed',
    lastName: 'Hassan',
    status: 'active',
    dateOfBirth: '1995-09-18',
    phone: '+31 6 56789012',
    site: 'Greenhouse B',
    contract: 'Harvester Contract',
    jobRole: 'Harvester',
    team: 'Team Gamma',
    supervisor: 'Peter Kowalski',
    employmentStartDate: '2023-06-05',
    securityRole: 'General',
    hasPin: false,
    careerHistory: [
      {
        id: 7,
        site: 'Greenhouse B',
        jobRole: 'Harvester',
        contract: 'Harvester Contract',
        team: 'Team Gamma',
        supervisor: 'Peter Kowalski',
        startedOn: '2023-06-05',
      },
    ],
    devices: [],
    notes: '',
    timeline: [
      {
        id: 14,
        date: '2023-06-05',
        type: 'employment',
        description: 'Joined as Harvester at Greenhouse B',
        performedBy: 'Thomas Müller',
      },
    ],
  },
  {
    id: 6,
    employeeNumber: 'EMP-0006',
    firstName: 'Elena',
    lastName: 'Popescu',
    status: 'inactive',
    dateOfBirth: '1990-02-14',
    phone: '+31 6 67890123',
    email: 'elena.popescu@example.com',
    site: 'Greenhouse A',
    contract: 'General Contract',
    jobRole: 'Packer',
    team: 'Team Beta',
    supervisor: 'Lisa Chen',
    employmentStartDate: '2020-09-01',
    securityRole: 'General',
    hasPin: true,
    lastLoginAt: '2026-05-15T07:11:00Z',
    careerHistory: [
      {
        id: 8,
        site: 'Greenhouse A',
        jobRole: 'Packer',
        contract: 'General Contract',
        team: 'Team Beta',
        supervisor: 'Lisa Chen',
        startedOn: '2020-09-01',
      },
    ],
    devices: [
      {
        id: 4,
        name: 'Phone A-04',
        identifier: 'LL-M3N4O5P6',
        isShared: false,
        assignedSince: '2020-09-01',
        assignedUntil: '2026-05-15',
      },
    ],
    notes: 'On extended leave. Expected to return Q3 2026.',
    timeline: [
      {
        id: 15,
        date: '2020-09-01',
        type: 'employment',
        description: 'Joined as Packer at Greenhouse A',
        performedBy: 'Thomas Müller',
      },
      {
        id: 16,
        date: '2020-09-01',
        type: 'device',
        description: 'Assigned device Phone A-04',
        performedBy: 'Thomas Müller',
      },
      {
        id: 17,
        date: '2026-05-15',
        type: 'employment',
        description: 'Status changed to Inactive — extended leave',
        performedBy: 'Thomas Müller',
      },
      {
        id: 18,
        date: '2026-05-15',
        type: 'device',
        description: 'Device Phone A-04 returned',
        performedBy: 'Lisa Chen',
      },
    ],
  },
  {
    id: 7,
    employeeNumber: 'EMP-0007',
    firstName: 'Thomas',
    lastName: 'Müller',
    status: 'active',
    dateOfBirth: '1975-12-01',
    phone: '+31 6 78901234',
    email: 'thomas.muller@labourlink.local',
    site: 'Greenhouse A',
    contract: 'Manager Contract',
    jobRole: 'Manager',
    employmentStartDate: '2015-01-01',
    securityRole: 'Manager',
    hasPin: true,
    lastLoginAt: '2026-06-29T09:00:00Z',
    careerHistory: [
      {
        id: 9,
        site: 'Greenhouse A',
        jobRole: 'Supervisor',
        contract: 'Supervisor Contract',
        startedOn: '2015-01-01',
        endedOn: '2018-12-31',
      },
      {
        id: 10,
        site: 'Greenhouse A',
        jobRole: 'Manager',
        contract: 'Manager Contract',
        startedOn: '2019-01-01',
      },
    ],
    devices: [
      {
        id: 5,
        name: 'Tablet Office',
        identifier: 'LL-Q7R8S9T0',
        isShared: true,
        assignedSince: '2019-01-01',
      },
    ],
    notes: 'Site manager for Greenhouse A. Also oversees operations at Greenhouse B.',
    timeline: [
      {
        id: 19,
        date: '2015-01-01',
        type: 'employment',
        description: 'Joined as Supervisor at Greenhouse A',
      },
      {
        id: 20,
        date: '2019-01-01',
        type: 'employment',
        description: 'Promoted to Manager',
      },
      {
        id: 21,
        date: '2019-01-01',
        type: 'security',
        description: 'Security role set to Manager',
      },
    ],
  },
  {
    id: 8,
    employeeNumber: 'EMP-0008',
    firstName: 'Fatima',
    lastName: 'Al-Rashidi',
    status: 'active',
    dateOfBirth: '1998-04-30',
    phone: '+31 6 89012345',
    site: 'Greenhouse A',
    contract: 'Harvester Contract',
    jobRole: 'Harvester',
    team: 'Team Alpha',
    supervisor: 'Lisa Chen',
    employmentStartDate: '2025-02-10',
    securityRole: 'General',
    hasPin: false,
    careerHistory: [
      {
        id: 11,
        site: 'Greenhouse A',
        jobRole: 'Harvester',
        contract: 'Harvester Contract',
        team: 'Team Alpha',
        supervisor: 'Lisa Chen',
        startedOn: '2025-02-10',
      },
    ],
    devices: [],
    notes: '',
    timeline: [
      {
        id: 22,
        date: '2025-02-10',
        type: 'employment',
        description: 'Joined as Harvester at Greenhouse A',
        performedBy: 'Lisa Chen',
      },
    ],
  },
];
