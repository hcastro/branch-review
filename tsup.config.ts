import {defineConfig} from "tsup";

export default defineConfig({
  entry: ["src/cli.tsx", "src/refreshWorker.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  dts: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
