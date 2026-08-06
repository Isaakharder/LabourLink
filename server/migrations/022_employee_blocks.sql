-- Employee Blocks: a named group of greenhouse rows assigned to one
-- employee (e.g. "the rows Lester is responsible for"). Purely an
-- organizational grouping — never touches greenhouse_rows/greenhouse_phases
-- geometry, and deleting a block only removes its row links (via cascade
-- below), never the rows themselves.
create table employee_blocks (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  employee_id uuid references employees(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- greenhouse_row_id is the primary key (not a composite of block_id +
-- greenhouse_row_id) specifically so "each row belongs to at most one
-- block" is enforced by the schema itself, not just app logic — a second
-- insert for the same row simply can't happen.
create table employee_block_rows (
  block_id uuid not null references employee_blocks(id) on delete cascade,
  greenhouse_row_id uuid primary key references greenhouse_rows(id) on delete cascade
);

create index idx_employee_block_rows_block on employee_block_rows (block_id);
