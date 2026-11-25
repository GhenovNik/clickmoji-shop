import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
    // scripts/lib holds standalone tooling that keeps legacy reads out of `src` (AGE-1667 Я3).
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'scripts/lib/**/*.{test,spec}.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    passWithNoTests: true,
    coverage: {
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'src/test/**',
        '**/*.d.ts',
        '**/*.config.*',
        '**/mockData',
        '.next/',
      ],
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
