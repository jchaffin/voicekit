import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["test/*.test.ts"],
  format: ["esm"],
  outDir: ".test-dist",
  clean: true,
  platform: "node",
  target: "es2022",
  dts: false,
  noExternal: [/^@jchaffin\/voicekit-/],
});
