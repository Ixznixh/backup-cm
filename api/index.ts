/**
 * Vercel serverless entry point.
 *
 * The Express app is created lazily on the first request instead of at module load:
 * serverless cold starts are unforgiving about module-scope work, and if anything in the
 * music stack throws while being imported the whole invocation dies with an opaque
 * FUNCTION_INVOCATION_FAILED. Loading it inside the handler means a failure surfaces as a
 * readable JSON error instead of a blank 500.
 */

import express, { type Express, type Request, type Response } from 'express';

let appPromise: Promise<Express> | null = null;

async function createApp(): Promise<Express> {
  const { apiRouter } = await import('../server/index');

  const app = express();
  app.use(express.json());

  // CORS configuration for Vercel
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }
    next();
  });

  app.get('/api/status', (_req, res) => {
    res.json({
      provider: 'YouTube Music (youtubei.js)',
      requiresApiKey: false,
      status: 'operational',
      platform: 'Vercel Serverless Function',
    });
  });

  // The rewrite in vercel.json can hand us the path either with or without the /api prefix,
  // so mount the router at every shape the request may arrive in.
  app.use('/api/music', apiRouter);
  app.use('/api', apiRouter);
  app.use('/music', apiRouter);
  app.use('/', apiRouter);

  return app;
}

function loadApp(): Promise<Express> {
  if (!appPromise) {
    appPromise = createApp().catch((err) => {
      appPromise = null;
      throw err;
    });
  }
  return appPromise;
}

export default async function handler(req: Request, res: Response): Promise<void> {
  try {
    const app = await loadApp();
    app(req, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api] failed to start Express app:', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Music API failed to start', message }));
    }
  }
}
