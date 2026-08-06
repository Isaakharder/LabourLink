// DTOs for /api/employee-blocks — server/src/routes/employeeBlocks.ts.

export interface EmployeeBlockLinkedRow {
  id: string;
  rowNumber: number;
  phaseName: string;
}

export interface EmployeeBlockSummary {
  id: string;
  name: string;
  employeeId: string | null;
  employeeName: string | null;
  rowCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface EmployeeBlockDetail extends EmployeeBlockSummary {
  rows: EmployeeBlockLinkedRow[];
}

// One entry per currently-linked row, across every block — GET
// /api/employee-blocks/row-links. Used only by the Link Rows map to know
// which rows already belong to a block (and which one), so it can
// highlight them and confirm before reassigning.
export interface EmployeeBlockRowLink {
  greenhouseRowId: string;
  blockId: string;
  blockName: string;
}
