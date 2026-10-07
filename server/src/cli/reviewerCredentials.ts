// Manage app-store reviewer pairing codes on the DEMO instance's database
// (see migrations/058_reviewer_pairing.sql). Point DATABASE_URL at the demo
// database; this refuses to run against any database without the
// demo_instance marker, so it can't mint reviewer codes in production.
//
//   npm run reviewer:credentials -- create "Google Play review" [--max-devices 25]
//   npm run reviewer:credentials -- list
//   npm run reviewer:credentials -- revoke <id> [--keep-devices]
//   npm run reviewer:credentials -- rotate <id>
//
// revoke: the code stops working immediately and, unless --keep-devices,
//         every device it paired is deactivated (the app shows "deactivated").
// rotate: issues a replacement code and revokes the old one, but keeps the
//         devices it already paired working, so a review in progress isn't
//         interrupted.
import "dotenv/config";
import { pool } from "../db";
import { generateReviewerCode, hasDemoInstanceMarker } from "../lib/demoInstance";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usage(): never {
  console.error(
    [
      "Usage:",
      '  npm run reviewer:credentials -- create "<label>" [--max-devices N]',
      "  npm run reviewer:credentials -- list",
      "  npm run reviewer:credentials -- revoke <id> [--keep-devices]",
      "  npm run reviewer:credentials -- rotate <id>",
    ].join("\n")
  );
  process.exit(1);
}

function printCode(code: string) {
  console.log("");
  console.log("Reviewer access code (copy this now — it cannot be retrieved again):");
  console.log(`  ${code}`);
  console.log("");
}

async function create(label: string, maxDevices: number) {
  const { code, codeHash, codeHint } = generateReviewerCode();
  const { rows } = await pool.query(
    `insert into reviewer_pairing_credentials (label, code_hash, code_hint, max_devices)
     values ($1, $2, $3, $4) returning id, label, max_devices`,
    [label, codeHash, codeHint, maxDevices]
  );
  console.log("Created reviewer credential:", rows[0]);
  printCode(code);
}

async function list() {
  const { rows } = await pool.query(
    `select c.id, c.label, '…' || c.code_hint as code_ends, c.max_devices,
            count(d.id)::int as devices_paired,
            count(d.id) filter (where d.is_active)::int as devices_active,
            c.created_at, c.last_used_at, c.revoked_at
     from reviewer_pairing_credentials c
     left join devices d on d.paired_via_reviewer_credential_id = c.id
     group by c.id order by c.created_at`
  );
  console.table(rows);
}

async function revoke(id: string, keepDevices: boolean) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const revoked = await client.query(
      `update reviewer_pairing_credentials set revoked_at = now()
       where id = $1 and revoked_at is null returning id, label`,
      [id]
    );
    if (!revoked.rows[0]) throw new Error(`No active reviewer credential with id ${id}`);
    let deactivated = 0;
    if (!keepDevices) {
      const devices = await client.query(
        `update devices set is_active = false, updated_at = now()
         where paired_via_reviewer_credential_id = $1 and is_active returning id`,
        [id]
      );
      deactivated = devices.rowCount ?? 0;
    }
    await client.query("commit");
    console.log(`Revoked "${revoked.rows[0].label}". Devices deactivated: ${keepDevices ? "none (--keep-devices)" : deactivated}.`);
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

async function rotate(id: string) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const old = await client.query(
      `update reviewer_pairing_credentials set revoked_at = now()
       where id = $1 and revoked_at is null returning label, max_devices`,
      [id]
    );
    if (!old.rows[0]) throw new Error(`No active reviewer credential with id ${id}`);
    const { code, codeHash, codeHint } = generateReviewerCode();
    const { rows } = await client.query(
      `insert into reviewer_pairing_credentials (label, code_hash, code_hint, max_devices)
       values ($1, $2, $3, $4) returning id, label, max_devices`,
      [old.rows[0].label, codeHash, codeHint, old.rows[0].max_devices]
    );
    await client.query("commit");
    console.log("Old code revoked (devices it already paired keep working). New credential:", rows[0]);
    printCode(code);
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

async function run() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) usage();

  if (!(await hasDemoInstanceMarker(pool))) {
    throw new Error(
      "This database is not a LabourLink demo instance (no demo_instance row). " +
        "Point DATABASE_URL at the demo database — reviewer codes are never created in production."
    );
  }

  if (command === "create") {
    const label = rest.find((a) => !a.startsWith("--"));
    if (!label) usage();
    const flag = rest.indexOf("--max-devices");
    const maxDevices = flag >= 0 ? Number(rest[flag + 1]) : 25;
    if (!Number.isInteger(maxDevices) || maxDevices < 1 || maxDevices > 500) {
      throw new Error("--max-devices must be a whole number from 1 to 500");
    }
    await create(label, maxDevices);
  } else if (command === "list") {
    await list();
  } else if (command === "revoke" || command === "rotate") {
    const id = rest.find((a) => !a.startsWith("--"));
    if (!id || !UUID_RE.test(id)) usage();
    if (command === "revoke") await revoke(id, rest.includes("--keep-devices"));
    else await rotate(id);
  } else {
    usage();
  }
}

run()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
