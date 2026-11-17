import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { apiRouter } from './server/api.ts';

function isTransientNetworkOrTimeoutError(err: any): boolean {
  const msg = String(err?.message || err?.errorMessage || err || '');
  const code = String(err?.code || '');
  return (
    msg === 'TIMEOUT' ||
    msg.includes('TIMEOUT') ||
    msg.includes('timed out') ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN'
  );
}

process.on('unhandledRejection', (reason: any) => {
  if (isTransientNetworkOrTimeoutError(reason)) {
    console.warn('[FRAME] Suppressed transient background timeout rejection:', reason?.message || reason);
    return;
  }
  console.warn('[FRAME] Unhandled promise rejection:', reason?.message || reason);
});

process.on('uncaughtException', (err: any) => {
  if (err?.code === 'EADDRINUSE' || err?.code === 'EACCES') {
    console.error('[FRAME] Fatal server bind error:', err);
    process.exit(1);
  }
  if (isTransientNetworkOrTimeoutError(err)) {
    console.warn('[FRAME] Suppressed transient background timeout exception:', err?.message || err);
    return;
  }
  console.error('[FRAME] Uncaught exception:', err);
});

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Body parser limits for large requests
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Mount API routes FIRST before frontend/Vite
app.use('/api', apiRouter);

async function startServer() {
  const isProduction = process.env.NODE_ENV === 'production';
  const distPath = path.resolve(process.cwd(), 'dist');

  if (isProduction && fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    // Mount Vite dev server in middleware mode
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[FRAME] Full-stack dev server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[FRAME] Failed to start server:', err);
  process.exit(1);
});


