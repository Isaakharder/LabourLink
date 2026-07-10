import { Router, Request, Response } from 'express';
import { db } from '../db';

export const healthRouter = Router();

// Checks real DB readiness, not just process liveness — used by the Docker
// HEALTHCHECK directives and nginx's /health proxy location.
healthRouter.get('/', async (_req: Request, res: Response) => {
  try {
    await db.query('SELECT 1');
    res.json({
      status: 'ok',
      application: 'LabourLink',
    });
  } catch (err) {
    console.error('GET /health', err);
    res.status(503).json({
      status: 'unavailable',
      application: 'LabourLink',
      error: 'Database unreachable',
    });
  }
});
