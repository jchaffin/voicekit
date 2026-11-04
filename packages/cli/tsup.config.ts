import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "node20",
    external: ["@jchaffin/voicekit-deploy"],
    outExtension({ format }) {
      return { js: format === "cjs" ? ".cjs" : ".js" };
    },
  },
  {
    entry: ["src/bin.ts"],
    format: ["esm"],
    sourcemap: true,
    target: "node20",
    banner: { js: "#!/usr/bin/env node" },
    external: ["@jchaffin/voicekit-deploy"],
  },
]);
