// Employee-block progress for the Dashboard's Row/Stem Work card: how many
// of an employee's currently-assigned block's linked rows are confirmed
// complete (row_completions, 026_row_completions.sql — the same source of
// truth Inputs/Reports already trust), and how many stems/plants remain on
// the not-yet-completed ones (plant_density_rows, 024_plant_density_types.sql).
//
// Must be called once per distinct densityType present among the current
// card set, never with employees of different density types sharing one
// call — an employee on a 'plants' activity and one on a 'stems' activity
// can never share a single density_type query parameter, or whichever group
// doesn't match would silently get wrong (or null) numbers.
import { pool } from "../db";

export interface BlockProgress {
  employeeId: string;
  blockId: string;
  blockName: string;
  totalRows: number;
  completedRows: number;
  // null only when at least one not-yet-completed row has no density link
  // for this densityType — see rowsMissingDensity below; never a silently
  // wrong partial sum.
  remainingStems: number | null;
  rowsMissingDensity: number;
}

export async function getBlockProgressForEmployees(
  employeeIds: string[],
  densityType: "plants" | "stems"
): Promise<Map<string, BlockProgress>> {
  const result = new Map<string, BlockProgress>();
  if (employeeIds.length === 0) return result;

  const { rows } = await pool.query(
    `with target_blocks as (
       -- Most-recently-updated block wins when an employee somehow has more
       -- than one (employee_blocks.employee_id carries no uniqueness
       -- constraint) — a documented tiebreak, not a real expected case.
       select distinct on (eb.employee_id) eb.id as block_id, eb.employee_id, eb.name as block_name
       from employee_blocks eb
       where eb.employee_id = any($1::uuid[])
       order by eb.employee_id, eb.updated_at desc, eb.created_at desc
     ),
     row_status as (
       select tb.employee_id, tb.block_id, tb.block_name, ebr.greenhouse_row_id,
              -- exists(), not a join, so a future row_completions row that
              -- somehow isn't unique per greenhouse_row_id can never fan out
              -- this query's grain (one row per block row, guaranteed).
              exists (
                select 1 from row_completions rc
                where rc.greenhouse_row_id = ebr.greenhouse_row_id and rc.density_type = $2
              ) as is_completed,
              -- count_per_row lives on plant_densities itself (the named
              -- density definition), not on plant_density_rows (the
              -- row-to-density link table) — see 024_plant_density_types.sql.
              pd.count_per_row
       from target_blocks tb
       left join employee_block_rows ebr on ebr.block_id = tb.block_id
       left join plant_density_rows pdr
         on pdr.greenhouse_row_id = ebr.greenhouse_row_id and pdr.density_type = $2
       left join plant_densities pd on pd.id = pdr.density_id
     )
     select employee_id, block_id, block_name,
       count(greenhouse_row_id) as total_rows,
       count(*) filter (where is_completed) as completed_rows,
       sum(count_per_row) filter (where not is_completed) as remaining_stems,
       count(*) filter (where not is_completed and count_per_row is null and greenhouse_row_id is not null) as rows_missing_density
     from row_status
     group by employee_id, block_id, block_name`,
    [employeeIds, densityType]
  );

  for (const r of rows) {
    const rowsMissingDensity = Number(r.rows_missing_density);
    result.set(r.employee_id, {
      employeeId: r.employee_id,
      blockId: r.block_id,
      blockName: r.block_name,
      totalRows: Number(r.total_rows),
      completedRows: Number(r.completed_rows),
      remainingStems: rowsMissingDensity > 0 ? null : Number(r.remaining_stems ?? 0),
      rowsMissingDensity,
    });
  }
  return result;
}
