import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['test/*.test.ts'],
  format: ['esm'],
  platform: 'node',
  dts: false,
  clean: true,
  outDir: '.test-dist',
  external: ['node:test', 'node:assert/strict'],
});
