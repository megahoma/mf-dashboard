import { defineConfig, globalIgnores, js, ts } from "@rslint/core";

export default defineConfig([
  globalIgnores(["dist/**", "node_modules/**"]),
  js.configs.recommended,
  ts.configs.recommended,
]);
