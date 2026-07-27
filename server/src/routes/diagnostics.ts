import dns from "dns";
import { Router } from "express";
import { Pool } from "pg";

const router = Router();

interface DbCheckResult {
  target: string;
  hostname: string;
  port: string;
  username: string | null;
  passwordLength: number;
  passwordHasWhitespace: boolean;
  passwordHasQuoteChars: boolean;
  sslmode: string | null;
  uselibpqcompat: string | null;
  resolvedFamily: number | null;
  resolvedAddress: string | null;
  connectionStartedAt: string;
  success: boolean;
  durationMs: number;
  errorCode?: string;
  errorMessage?: string;
}

async function checkConnection(
  rawConnectionString: string,
  label: string
): Promise<DbCheckResult> {
  const url = new URL(rawConnectionString);
  const hostname = url.hostname;
  const password = decodeURIComponent(url.password);

  let resolvedFamily: number | null = null;
  let resolvedAddress: string | null = null;
  try {
    const dnsResult = await dns.promises.lookup(hostname);
    resolvedFamily = dnsResult.family;
    resolvedAddress = dnsResult.address;
  } catch {
    // Leave nulls — the connection attempt below will surface the real error.
  }

  if (!url.searchParams.has("sslmode")) {
    url.searchParams.set("sslmode", "require");
  }
  if (!url.searchParams.has("uselibpqcompat")) {
    url.searchParams.set("uselibpqcompat", "true");
  }

  const base: Omit<
    DbCheckResult,
    "success" | "durationMs" | "errorCode" | "errorMessage"
  > = {
    target: label,
    hostname,
    port: url.port,
    username: url.username || null,
    passwordLength: password.length,
    passwordHasWhitespace: password !== password.trim(),
    passwordHasQuoteChars: /['"]/.test(password),
    sslmode: url.searchParams.get("sslmode"),
    uselibpqcompat: url.searchParams.get("uselibpqcompat"),
    resolvedFamily,
    resolvedAddress,
    connectionStartedAt: new Date().toISOString(),
  };

  const pool = new Pool({
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: false },
    max: 5,
    connectionTimeoutMillis: 8000,
  });

  const start = Date.now();
  try {
    // Deliberately the simple query form (no named prepared statement) so
    // this is safe to run against a transaction-mode pgbouncer too.
    await pool.query("select 1 as ok");
    return { ...base, success: true, durationMs: Date.now() - start };
  } catch (err) {
    const pgErr = err as NodeJS.ErrnoException;
    return {
      ...base,
      success: false,
      durationMs: Date.now() - start,
      errorCode: pgErr.code,
      errorMessage: pgErr.message,
    };
  } finally {
    await pool.end().catch(() => {});
  }
}

// Temporary diagnostic route for the Phase 1 Railway<->Supabase connectivity
// issue — remove once resolved. Fails closed (404, not 401/403, so its
// existence isn't revealed) unless DIAGNOSTIC_TOKEN is set and matched,
// so it can't be left accidentally open if the env var is ever unset.
router.get("/db-check", async (req, res) => {
  const token = process.env.DIAGNOSTIC_TOKEN;
  if (!token || req.query.token !== token) {
    return res.status(404).end();
  }

  const results: DbCheckResult[] = [];

  if (process.env.DATABASE_URL) {
    results.push(
      await checkConnection(process.env.DATABASE_URL, "session-pooler (DATABASE_URL)")
    );
  }

  if (process.env.DIAGNOSTIC_TRANSACTION_POOLER_URL) {
    results.push(
      await checkConnection(
        process.env.DIAGNOSTIC_TRANSACTION_POOLER_URL,
        "transaction-pooler"
      )
    );
  }

  console.log("[db-check]", JSON.stringify(results));
  res.json({ results });
});

export default router;
