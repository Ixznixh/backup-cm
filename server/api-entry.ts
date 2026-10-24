/**
 * Vercel serverless entry point.
 *
 * `scripts/build-api.mjs` bundles this file into `api/index.js` before Vercel packages the
 * function. Bundling matters: Vercel compiles each TypeScript file on its own, and the
 * extensionless relative imports used across `server/` do not resolve as native ESM — which
 * is why every request failed with "Cannot find module /var/task/server/index".
 *
 * The Express app is also created lazily on the first request instead of at module load, so a
 * failure starting the music stack surfaces as readable JSON instead of FUNCTION_INVOCATION_FAILED.
 */

import express, { type Express, type Request, type Response } from 'express';

let appPromise: Promise<Express> | null = null;

async function createApp(): Promise<Express> {
  // Static relative import: the bundler resolves it at build time, so nothing has to resolve
  // extensionless TypeScript paths inside the deployed function.
  const { apiRouter } = await import('./index');

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
