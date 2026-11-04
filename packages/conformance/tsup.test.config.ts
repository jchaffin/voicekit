import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["test/*.test.ts"],
  outDir: ".test-dist",
  format: ["esm"],
  platform: "node",
  target: "es2022",
  clean: true,
  sourcemap: true,
  external: ["node:test", "node:assert/strict"],
});
