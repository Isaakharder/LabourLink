// One-time (or occasional) setup: create an integration_tokens row and
// print its raw bearer token once. There is no way to retrieve it again
// afterward — only its sha256 hash is ever stored (see
// 054_integration_tokens.sql's own comment on why this is deliberately
// stricter than greenhouse_displays' recoverable display_key_plaintext). If
// the printed token is lost, deactivate the row (`is_active = false`) or
// delete it, then run this script again for a replacement.
//
// Usage:
//   npm run create-integration-token -- "Productive TV"
import "dotenv/config";
import { pool } from "../db";
import { generateIntegrationToken } from "../lib/integrationToken";

async function run() {
  const [name] = process.argv.slice(2);
  if (!name) {
    console.error('Usage: npm run create-integration-token -- "Token Name"');
    process.exit(1);
  }

  const { token, tokenHash } = generateIntegrationToken();

  const { rows } = await pool.query(`insert into integration_tokens (name, token_hash) values ($1, $2) returning id, name`, [
    name,
    tokenHash,
  ]);

  console.log("Created integration token:", rows[0]);
  console.log("");
  console.log("Bearer token (copy this now — it cannot be retrieved again):");
  console.log(`  ${token}`);
  console.log("");
  console.log("Configure the calling machine to send this header on every request:");
  console.log(`  Authorization: Bearer ${token}`);
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
