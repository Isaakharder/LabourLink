// Seeds a brand-new, empty LabourLink database as the app-store DEMO instance
// (see migrations/058_reviewer_pairing.sql): fictional employees, jobs,
// greenhouse rows and carts, plus the demo_instance marker the reviewer
// pairing endpoint requires.
//
// Refuses unless LABOURLINK_DEMO_INSTANCE=true AND the database has no
// employees at all — so it can never be pointed at production by mistake.
// Re-running against an already-seeded demo database is a no-op.
//
//   LABOURLINK_DEMO_INSTANCE=true DATABASE_URL=<demo db> npm run demo:seed
//
// Every person here is invented, with no email, phone, date of birth or
// other personal details, so the demo instance never sends email and holds
// nothing that identifies a real person.
import "dotenv/config";
import { pool } from "../db";
import { hasDemoInstanceMarker, isDemoInstanceEnabled } from "../lib/demoInstance";

const PEOPLE: { first: string; last: string; number: string; role: string; team: string }[] = [
  { first: "Sam", last: "Rivera", number: "DEMO-001", role: "Administrator", team: "Team Leader" },
  { first: "Jordan", last: "Lee", number: "DEMO-002", role: "Crew Leader", team: "Team Leader" },
  { first: "Casey", last: "Morgan", number: "DEMO-003", role: "Employee", team: "Team Member" },
  { first: "Taylor", last: "Brooks", number: "DEMO-004", role: "Employee", team: "Team Member" },
  { first: "Riley", last: "Chen", number: "DEMO-005", role: "Employee", team: "Assistant Team Leader" },
];

// questions: which pickers the app shows before the job starts.
const ACTIVITIES: { name: string; questions: ("greenhouse_row" | "carrier")[]; densitySource: "stems" | null }[] = [
  { name: "Picking", questions: ["greenhouse_row", "carrier"], densitySource: null },
  { name: "Pruning", questions: ["greenhouse_row"], densitySource: "stems" },
  { name: "Leaf Clearing", questions: ["greenhouse_row"], densitySource: null },
  { name: "Cleaning", questions: [], densitySource: null },
  { name: "Training", questions: [], densitySource: null },
];

const PHASES = [
  { name: "Phase 1", x: 0 },
  { name: "Phase 2", x: 210 },
];
const ROWS_PER_PHASE = 12;
const CARRIER_COUNT = 8; // single digits, so the app's name-sorted cart list reads 1–8 in order

async function run() {
  if (!isDemoInstanceEnabled()) {
    throw new Error("Refusing to seed: set LABOURLINK_DEMO_INSTANCE=true to confirm this is the demo database.");
  }
  if (await hasDemoInstanceMarker(pool)) {
    console.log("This database is already a seeded demo instance — nothing to do.");
    return;
  }
  const { rows: count } = await pool.query(`select count(*)::int as n from employees`);
  if (count[0].n > 0) {
    throw new Error(
      `Refusing to seed: this database already has ${count[0].n} employee(s). ` +
        "The demo instance must be a separate, empty database."
    );
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`insert into demo_instance (label) values ('LabourLink app-review demo (fictional data)')`);

    const breakProfile = await client.query(
      `insert into break_profiles (name, description) values ('Demo Day Shift', 'Sample break schedule') returning id`
    );
    const breakProfileId = breakProfile.rows[0].id;
    const breaks = [
      ["Morning break", "10:00", "10:15", true],
      ["Lunch", "12:00", "12:30", false],
      ["Afternoon break", "15:00", "15:15", true],
    ] as const;
    for (let i = 0; i < breaks.length; i++) {
      const [name, start, end, paid] = breaks[i];
      await client.query(
        `insert into break_profile_items (break_profile_id, name, start_time, end_time, is_paid, sort_order)
         values ($1, $2, $3, $4, $5, $6)`,
        [breakProfileId, name, start, end, paid, i]
      );
    }

    const crewGroup = await client.query(`insert into employee_groups (name) values ('Crew A') returning id`);
    await client.query(`insert into employee_groups (name) values ('Reviewers')`);

    const employeeIds: string[] = [];
    for (const p of PEOPLE) {
      const { rows } = await client.query(
        `insert into employees (first_name, last_name, employee_number, security_role_id, team_role_id,
                                preferred_language, break_profile_id, employee_group_id, start_date, notes)
         values ($1, $2, $3,
                 (select id from security_roles where name = $4),
                 (select id from team_roles where name = $5),
                 'English', $6, $7, current_date - 30, 'Fictional demo employee.')
         returning id`,
        [p.first, p.last, p.number, p.role, p.team, breakProfileId, crewGroup.rows[0].id]
      );
      employeeIds.push(rows[0].id);
    }

    const group = await client.query(
      `insert into activity_groups (name, description) values ('Greenhouse Crew', 'All demo jobs') returning id`
    );
    const groupId = group.rows[0].id;
    for (let i = 0; i < ACTIVITIES.length; i++) {
      const a = ACTIVITIES[i];
      const { rows } = await client.query(
        `insert into activities (name, sort_order, density_source) values ($1, $2, $3) returning id`,
        [a.name, i, a.densitySource]
      );
      const activityId = rows[0].id;
      await client.query(`insert into activity_group_activities (activity_group_id, activity_id) values ($1, $2)`, [
        groupId,
        activityId,
      ]);
      for (let q = 0; q < a.questions.length; q++) {
        const type = a.questions[q];
        await client.query(
          `insert into activity_questions (activity_id, question_type, label, sort_order) values ($1, $2, $3, $4)`,
          [activityId, type, type === "greenhouse_row" ? "Which row?" : "Which cart?", q]
        );
      }
    }
    for (const employeeId of employeeIds) {
      await client.query(
        `insert into employee_activity_group_assignments (employee_id, activity_group_id) values ($1, $2)`,
        [employeeId, groupId]
      );
    }

    const land = await client.query(
      `insert into greenhouse_lands (name, north_south_feet, east_west_feet) values ('Demo Greenhouse', 300, 420) returning id`
    );
    const density = await client.query(
      `insert into plant_densities (name, type, count_per_row) values ('Demo stems', 'stems', 400) returning id`
    );
    for (let p = 0; p < PHASES.length; p++) {
      const phase = await client.query(
        `insert into greenhouse_phases (land_id, name, north_south_feet, east_west_feet, x_feet_from_west, sort_order)
         values ($1, $2, 300, 210, $3, $4) returning id`,
        [land.rows[0].id, PHASES[p].name, PHASES[p].x, p]
      );
      for (let r = 1; r <= ROWS_PER_PHASE; r++) {
        const row = await client.query(
          `insert into greenhouse_rows (phase_id, row_number, x_ft, y_ft, width_ft, length_ft, orientation)
           values ($1, $2, $3, 10, 4, 280, 'vertical') returning id`,
          [phase.rows[0].id, r, 5 + (r - 1) * 17]
        );
        await client.query(
          `insert into plant_density_rows (density_id, greenhouse_row_id, density_type) values ($1, $2, 'stems')`,
          [density.rows[0].id, row.rows[0].id]
        );
      }
    }

    for (let c = 1; c <= CARRIER_COUNT; c++) {
      await client.query(`insert into carriers (name) values ($1)`, [`Cart ${c}`]);
    }

    await client.query("commit");
    console.log(
      `Seeded demo instance: ${PEOPLE.length} fictional employees, ${ACTIVITIES.length} jobs, ` +
        `${PHASES.length * ROWS_PER_PHASE} rows, ${CARRIER_COUNT} carts.`
    );
    console.log('Next: npm run reviewer:credentials -- create "Google Play review"');
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

run()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
