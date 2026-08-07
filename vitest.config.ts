import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'contracts/tests/**/*.test.ts',
      'packages/**/*.test.ts',
      'services/**/tests/**/*.test.ts',
      'scripts/**/*.test.ts',
    ],
    // Circuit execution runs the on-chain runtime through WASM; the default
    // 5s timeout is tight for the first test in a file, which pays WASM init.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
