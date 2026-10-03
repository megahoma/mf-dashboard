import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  linkTypesDir,
  localManifestUrl,
  rowAction,
  withActionTokens,
} from "../src/widgets/mf-dashboard-tree/targets.ts";

const files = new Set(["/apps/shell/module-federation.config.ts", "/apps/shell/@mf-types"]);

test("types actions require a directory, not a file", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mf-row-targets-"));
  try {
    const typesDir = path.join(root, "@mf-types");
    const input = { configFile: null, producerConfigFile: null, manifestUrl: null, typesDir };
    assert.equal(rowAction(input).typesDir, null);
    writeFileSync(typesDir, "not a directory");
    assert.deepEqual(rowAction(input).tokens, []);
    rmSync(typesDir);
    mkdirSync(typesDir);
    assert.deepEqual(rowAction(input).tokens, ["types"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function exists(file: string): boolean {
  return files.has(file);
}

test("local manifest URL joins the port and the path", () => {
  assert.equal(
    localManifestUrl(3001, "/mf-manifest.json"),
    "http://127.0.0.1:3001/mf-manifest.json",
  );
  assert.equal(
    localManifestUrl(3001, "mf-manifest.json"),
    "http://127.0.0.1:3001/mf-manifest.json",
  );
});

test("a link with a types directory exposes config, producer, types, and manifest", () => {
  const action = rowAction(
    {
      configFile: "/apps/shell/module-federation.config.ts",
      producerConfigFile: "/apps/widget/module-federation.config.ts",
      typesDir: "/apps/shell/@mf-types",
      manifestUrl: "http://127.0.0.1:3002/mf-manifest.json",
    },
    exists,
  );
  assert.equal(action.configFile, "/apps/shell/module-federation.config.ts");
  assert.equal(action.producerConfigFile, "/apps/widget/module-federation.config.ts");
  assert.equal(action.typesDir, "/apps/shell/@mf-types");
  assert.equal(action.manifestUrl, "http://127.0.0.1:3002/mf-manifest.json");
  assert.deepEqual(action.tokens, ["config", "producer", "types", "manifest"]);
});

test("hides types when the directory is missing and hides a bad manifest URL", () => {
  const action = rowAction(
    {
      configFile: "/apps/shell/module-federation.config.ts",
      producerConfigFile: "/apps/shell/module-federation.config.ts",
      typesDir: "/apps/shell/@mf-types/missing",
      manifestUrl: "http://${HOST}/mf-manifest.json",
    },
    exists,
  );
  assert.equal(action.producerConfigFile, null);
  assert.equal(action.typesDir, null);
  assert.equal(action.manifestUrl, null);
  assert.deepEqual(action.tokens, ["config"]);
});

test("config stays available when the file is not on disk", () => {
  const action = rowAction(
    {
      configFile: "/missing/module-federation.config.ts",
      producerConfigFile: null,
      typesDir: null,
      manifestUrl: null,
    },
    exists,
  );
  assert.equal(action.configFile, "/missing/module-federation.config.ts");
  assert.deepEqual(action.tokens, ["config"]);
});

test("link types dir stays inside the consumer and rejects a parent segment", () => {
  assert.equal(linkTypesDir("/apps/shell", "widget", "@mf-types"), "/apps/shell/@mf-types/widget");
  assert.equal(linkTypesDir("/apps/shell", "../widget", "@mf-types"), null);
});

test("tokens are appended without dropping the status word", () => {
  assert.equal(withActionTokens("silent", ["config", "manifest"]), "silent config manifest");
  assert.equal(withActionTokens("unfetched.pending", ["config"]), "unfetched.pending config");
  assert.equal(withActionTokens("listen", []), "listen");
});
