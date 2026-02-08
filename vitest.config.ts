import { defineConfig } from 'vitest/config';

/**
 * Root Vitest configuration for Browser Debug MCP Bridge
 * Provides shared defaults for all projects
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.d.ts',
        '**/*.config.ts',
        '**/public/**',
      ],
    },
  },
});
