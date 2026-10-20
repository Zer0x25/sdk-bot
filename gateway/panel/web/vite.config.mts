import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: 'panel/web',
  base: '/inbox/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/vitestSetup.ts'],
    globals: true,
    restoreMocks: true,
    clearMocks: true
  }
});
