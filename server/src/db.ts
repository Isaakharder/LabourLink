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
});
