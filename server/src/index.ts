import express from 'express';
import cors from 'cors';
import session from 'express-session';
import dotenv from 'dotenv';
import { db } from './db';
import { runMigrations } from './migrate';
import { PgSessionStore } from './lib/pgSessionStore';
import { healthRouter } from './routes/health';
import { authRouter } from './routes/auth';
import { setupRouter } from './routes/setup';
import { usersRouter } from './routes/users';
import { employeesRouter } from './routes/employees';
import { activitiesRouter } from './routes/activities';
import { locationsRouter } from './routes/locations';
import { workRouter } from './routes/work';
import { contractsRouter } from './routes/contracts';
import { locationGroupsRouter } from './routes/location-groups';
import { greenhouseMapsRouter } from './routes/greenhouse-maps';
import { cropsRouter } from './routes/crops';
import { varietiesRouter } from './routes/varieties';
import { requireAuth } from './middleware/auth';

dotenv.config();

const PORT = process.env.PORT ?? 4000;
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  throw new Error(
    'Missing required environment variable: SESSION_SECRET\n' +
      'Copy server/.env.example to server/.env and fill in the correct values.',
  );
}

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours, rolling

const app = express();

// Behind a reverse proxy in production, needed for secure cookies to work.
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(cors({ origin: WEB_ORIGIN, credentials: true }));
app.use(express.json());

app.use(
  session({
    name: 'labourlink.sid',
    secret: SESSION_SECRET,
    store: new PgSessionStore({ pool: db, ttlMs: SESSION_TTL_MS }),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: SESSION_TTL_MS,
    },
  }),
);

app.use('/health', healthRouter);
app.use('/api/setup', setupRouter);
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/employees', requireAuth, employeesRouter);
app.use('/api/activities', requireAuth, activitiesRouter);
app.use('/api/locations', requireAuth, locationsRouter);
app.use('/api/location-groups', requireAuth, locationGroupsRouter);
app.use('/api/work', requireAuth, workRouter);
app.use('/api/contracts', requireAuth, contractsRouter);
app.use('/api/greenhouse-maps', requireAuth, greenhouseMapsRouter);
app.use('/api/crops', requireAuth, cropsRouter);
app.use('/api/varieties', requireAuth, varietiesRouter);

async function start(): Promise<void> {
  await runMigrations(db);
  app.listen(PORT, () => {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`LabourLink API running on port ${PORT}`);
    }
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
