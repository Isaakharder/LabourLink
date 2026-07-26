// One-time bootstrap: create the first Administrator so someone can log in
// before the Employees CRUD page (Phase 2) exists.
//
// Usage:
//   npm run create-admin -- "Jane" "Doe" jane@example.com 123456

import "dotenv/config";
import { pool } from "../db";
import { hashPin } from "../lib/pin";

async function run() {
  const [firstName, lastName, email, pin] = process.argv.slice(2);

  if (!firstName || !lastName || !email || !pin) {
    console.error(
      'Usage: npm run create-admin -- "First" "Last" email@example.com <pin>'
    );
    process.exit(1);
  }

  if (!/^\d{4,8}$/.test(pin)) {
    console.error("PIN must be 4-8 digits.");
    process.exit(1);
  }

  const pinHash = await hashPin(pin);

  const { rows } = await pool.query(
    `insert into employees
      (first_name, last_name, email, security_role_id, team_role_id, settings_pin_hash, is_active)
     values
      ($1, $2, $3,
       (select id from security_roles where name = 'Administrator'),
       (select id from team_roles where name = 'Team Leader'),
       $4, true)
     returning id, first_name, last_name, email`,
    [firstName, lastName, email, pinHash]
  );

  console.log("Created administrator:", rows[0]);
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
