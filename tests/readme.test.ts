import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const keys = [
  "mf-dashboard.envMode",
  "mf-dashboard.language",
  "mf-dashboard.structure",
  "mf-dashboard.ignorePaths",
  "mf-dashboard.extraManifestUrls",
  "mf-dashboard.packageManager",
  "mf-dashboard.probeIntervalMs",
  "mf-dashboard.typesSettleMs",
  "mf-dashboard.terminal.reveal",
  "mf-dashboard.scripts.start",
  "mf-dashboard.commands.rebuildTypes",
  "mf-dashboard.commands.refetchTypes",
  "mf-dashboard.apps",
];

test("readme names every extension setting", () => {
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  for (const key of keys) assert.ok(readme.includes(key), key);
});
