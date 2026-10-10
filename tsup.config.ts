import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/s3.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ["just-bash", "@aws-sdk/client-s3"],
});
