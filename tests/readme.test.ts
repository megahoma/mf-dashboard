import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  contributes: { configuration: { properties: Record<string, unknown> } };
};

test("readme names every extension setting", () => {
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const keys = Object.keys(pkg.contributes.configuration.properties);
  assert.ok(keys.length > 0);
  for (const key of keys) assert.ok(readme.includes(key), key);
});
