import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["test/*.test.ts"],
  format: ["esm"],
  outDir: ".test-dist",
  clean: true,
  dts: false,
  sourcemap: false,
  target: "node20",
  external: ["node:assert/strict", "node:test"],
});
