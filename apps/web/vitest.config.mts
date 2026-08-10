import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname) } },
  test: {
    setupFiles: ['./vitest.setup.ts'],
    // Component files opt into a DOM with a `@vitest-environment jsdom`
    // docblock. The pure and live suites stay on node, so nothing pays for a
    // DOM it does not use.
    environment: 'node',
  },
});
