/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  worker: {
    // Module workers: `new Worker(new URL('./pathWorker.ts', import.meta.url), { type: 'module' })`
    format: 'es',
  },
  test: {
    include: ['src/tests/**/*.test.ts'],
    environment: 'node',
  },
});
