import { Pool, types } from 'pg';

// Return DATE columns as 'YYYY-MM-DD' strings (not JS Date objects)
types.setTypeParser(1082, (val: string) => val);

// Return BIGINT/BIGSERIAL as JS numbers (safe for IDs; won't exceed 2^53 in practice)
types.setTypeParser(20, Number);

const DB_PASSWORD = process.env.DB_PASSWORD;
if (!DB_PASSWORD) {
  throw new Error(
    'Missing required environment variable: DB_PASSWORD\n' +
    'Copy server/.env.example to server/.env and fill in the correct values.',
  );
}

export const db = new Pool({
  host:     process.env.DB_HOST ?? 'localhost',
  port:     parseInt(process.env.DB_PORT ?? '5432', 10),
  database: process.env.DB_NAME ?? 'labourlink',
  user:     process.env.DB_USER ?? 'labourlink',
  password: DB_PASSWORD,
});
