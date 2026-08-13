// One-time (or occasional) setup: create a greenhouse_displays row and print
// its raw TV URL once. Mirrors createAdmin.ts's pattern — this is what
// actually seeds the initial "Break Area TV" display; 016_greenhouse_
// displays.sql deliberately contains no seed insert (see that migration's
// own comment, and server/migrations/README.md's rule against baking seed
// rows into schema migrations).
//
// Usage:
//   npm run create-greenhouse-display -- "Break Area TV" "First Light Greenhouse"
//   npm run create-greenhouse-display -- "Break Area TV" <landId>
// The second argument may be a land's exact name or its id — whichever is
// more convenient at the terminal.
import "dotenv/config";
import { pool } from "../db";
import { generateDisplayKey } from "../lib/displayToken";
import { calendarDateInAppTimezone } from "../lib/timezone";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function run() {
  const [name, landRef] = process.argv.slice(2);
  if (!name || !landRef) {
    console.error('Usage: npm run create-greenhouse-display -- "Display Name" <landIdOrName>');
    process.exit(1);
  }

  const land = UUID_RE.test(landRef)
    ? await pool.query("select id, name from greenhouse_lands where id = $1", [landRef])
    : await pool.query("select id, name from greenhouse_lands where name = $1", [landRef]);
  if (!land.rows[0]) {
    console.error(`No greenhouse land found matching "${landRef}".`);
    process.exit(1);
  }

  const { token, tokenHash } = generateDisplayKey();
  const today = calendarDateInAppTimezone(new Date());

  const { rows } = await pool.query(
    `insert into greenhouse_displays (name, display_key_hash, display_key_plaintext, land_id, date_start, date_end)
     values ($1, $2, $3, $4, $5, $5)
     returning id, name`,
    [name, tokenHash, token, land.rows[0].id, today]
  );

  const webUrl = process.env.WEB_APP_URL || "http://localhost:5173";
  console.log("Created display:", rows[0]);
  console.log("Land:", land.rows[0].name);
  console.log("");
  console.log("TV URL (also retrievable later from Greenhouse -> Display in the app):");
  console.log(`  ${webUrl}/greenhouse/display/${token}`);
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
