import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { PoolCache } from './poolCache.js';

const port = Number.parseInt(process.env.PORT ?? '8787', 10);
const cache = new PoolCache({ ttlMs: Number.parseInt(process.env.CACHE_TTL_MS ?? '60000', 10) });
const app = createApp({ cache });

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`spidey scoring engine on http://localhost:${info.port}`);
  console.log('  GET /health');
  console.log('  GET /pools?stable=true');
  console.log('  GET /rank?size=10000&hold=7');
  console.log('  GET /compare?size=10000');
});

// Warm the cache so the first UI request is not the one that pays for it.
cache.get().then(
  (entry) => console.log(`warmed: ${entry.pools.length} pools in ${entry.durationMs}ms`),
  (error) => console.error('warm failed:', error.message),
);
