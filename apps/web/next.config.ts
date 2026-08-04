import type { NextConfig } from 'next';

const config: NextConfig = {
  // Workspace packages ship as TypeScript source with no build step.
  transpilePackages: ['@spidey/core'],
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8787',
  },
};

export default config;
