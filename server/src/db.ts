import { Pool, types } from 'pg';

// Return DATE columns as 'YYYY-MM-DD' strings (not JS Date objects)
types.setTypeParser(1082, (val: string) => val);

export const db = new Pool({
  host:     process.env.DB_HOST     ?? 'localhost',
  port:     parseInt(process.env.DB_PORT ?? '5432', 10),
  database: process.env.DB_NAME     ?? 'labourlink',
  user:     process.env.DB_USER     ?? 'labourlink',
  password: process.env.DB_PASSWORD ?? 'labourlink_secret',
});
