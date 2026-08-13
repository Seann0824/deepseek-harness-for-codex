import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/bin.ts"],
  clean: true,
  dts: false,
  format: ["esm"],
  minify: false,
  outDir: "dist",
  platform: "node",
  target: "node22",
});
