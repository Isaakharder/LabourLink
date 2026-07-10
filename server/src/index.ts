import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import session from 'express-session';
import dotenv from 'dotenv';
import { db } from './db';
import { runMigrations } from './migrate';
import { PgSessionStore } from './lib/pgSessionStore';
import { mobileAuth } from './middleware/mobileAuth';
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

const PORT = Number(process.env.PORT ?? 4000);
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  throw new Error(
    'Missing required environment variable: SESSION_SECRET\n' +
      'Copy server/.env.example to server/.env and fill in the correct values.',
  );
}

// Independent of NODE_ENV on purpose: plain local-network HTTP has no TLS,
// so a Secure cookie would be silently dropped by the browser and break
// login. Only set COOKIE_SECURE=true once a reverse proxy terminates real
// HTTPS in front of this stack. See docs/DEPLOYMENT.md.
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours, rolling

const app = express();

// Behind a reverse proxy in production, needed to read X-Forwarded-* from
// nginx correctly (client IP for rate limiting, req.protocol, etc.).
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(
  helmet({
    // No TLS on plain LAN HTTP — HSTS would be meaningless (or harmful if a
    // client caches it before HTTPS is ever added).
    hsts: false,
    // This API only ever returns JSON, never HTML to protect with a CSP.
    contentSecurityPolicy: false,
  }),
);
app.use(cors({ origin: WEB_ORIGIN, credentials: true }));
app.use(express.json({ limit: '1mb' }));

// Resolves req.user from a mobile Authorization: Bearer token, verified
// against the dedicated mobile_sessions table — entirely separate from the
// cookie-based express-session below. See middleware/mobileAuth.ts and
// lib/mobileSessions.ts for the full design.
app.use(mobileAuth(db));

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
      secure: COOKIE_SECURE,
      maxAge: SESSION_TTL_MS,
    },
  }),
);

// IP-based throttling, layered on top of (not replacing) the per-account
// lockout in routes/auth.ts (5 failed attempts / 15 min per account).
const generalApiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again later.' },
});

app.use('/health', healthRouter);

// All application routes are mounted on one router, then that same router
// instance is mounted at both /api (existing web app, unchanged) and
// /api/v1 (the path the future Android app should prefer). Mounting one
// Router at two paths is safe — Router carries no per-mount-path state,
// req.baseUrl/req.path adjust per request.
const apiRouter = express.Router();
apiRouter.use(generalApiLimiter);
apiRouter.use('/setup', authLimiter, setupRouter);
apiRouter.use('/auth', authLimiter, authRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/employees', requireAuth, employeesRouter);
apiRouter.use('/activities', requireAuth, activitiesRouter);
apiRouter.use('/locations', requireAuth, locationsRouter);
apiRouter.use('/location-groups', requireAuth, locationGroupsRouter);
apiRouter.use('/work', requireAuth, workRouter);
apiRouter.use('/contracts', requireAuth, contractsRouter);
apiRouter.use('/greenhouse-maps', requireAuth, greenhouseMapsRouter);
apiRouter.use('/crops', requireAuth, cropsRouter);
apiRouter.use('/varieties', requireAuth, varietiesRouter);

app.use('/api', apiRouter);
app.use('/api/v1', apiRouter);

// Consistent JSON for anything unmatched — never fall through to Express's
// default HTML 404 page.
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// Last-resort JSON error handler — never fall through to Express's default
// HTML error page for an uncaught/unhandled error.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
});

async function start(): Promise<void> {
  await runMigrations(db);
  app.listen(PORT, '0.0.0.0', () => {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`LabourLink API running on port ${PORT}`);
    }
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
