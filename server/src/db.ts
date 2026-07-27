import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

export const pool = new Pool({
  connectionString,
  // Supabase's pooled connection uses a certificate that Node won't validate
  // against a local CA bundle; this is the standard setting for that.
  ssl: { rejectUnauthorized: false },
  // Without these, a stalled TCP handshake (e.g. packets silently dropped by
  // a network restriction) hangs the request indefinitely instead of failing
  // fast — that's what turned into a 2-minute hang -> Railway 502 in prod.
  connectionTimeoutMillis: 8000,
  idleTimeoutMillis: 30000,
});
