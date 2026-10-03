import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readAppFolder } from "../src/entities/microfrontend/discover.ts";
import { createAppParseCache, loadKnownApps } from "../src/widgets/mf-dashboard-tree/session.ts";

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-known-app-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "apps", "widget");
  fs.mkdirSync(path.join(app, "src"), { recursive: true });
  const config = path.join(app, "module-federation.config.ts");
  fs.writeFileSync(config, 'export default { name: "widget", manifest: true, dts: false };\n');
  fs.writeFileSync(
    path.join(app, "src", "module-federation.config.ts"),
    'export default { name: "nested", manifest: true };\n',
  );
  const roots = [{ name: "root", path: root }];
  const settings = { widget: { path: "apps/widget" } };
  const cache = createAppParseCache();
  return { root, app, config, roots, settings, cache };
}

function rewrite(file: string, content: string) {
  const before = fs.existsSync(file) ? fs.statSync(file).mtimeMs : Date.now();
  fs.writeFileSync(file, content);
  fs.utimesSync(file, new Date(before + 1000), new Date(before + 1000));
}

test("known app read ignores nested configs and never walks child directories", (t) => {
  const { app } = fixture(t);
  const readdir = fs.readdirSync;
  const visited: string[] = [];
  t.mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
    visited.push(String(args[0]));
    return readdir(...args);
  });
  const found = readAppFolder(app, "development");
  assert.equal(found?.name, "widget");
  assert.equal(found?.folder, app);
  assert.deepEqual(visited, [app]);
});

test("unchanged known app reuses parsed config without reading bytes", (t) => {
  const { roots, settings, cache } = fixture(t);
  const first = loadKnownApps(roots, settings, "development", [], cache);
  let reads = 0;
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    reads++;
    return read(...args);
  });
  assert.deepEqual(loadKnownApps(roots, settings, "development", [], cache), first);
  assert.equal(reads, 0);
});

test("renamed config invalidates cache and keeps the single-root fallback", (t) => {
  const { roots, settings, cache, config } = fixture(t);
  assert.equal(loadKnownApps(roots, settings, "development", [], cache)[0]?.name, "widget");
  rewrite(config, 'export default { name: "renamed", manifest: true };\n');
  assert.equal(loadKnownApps(roots, settings, "development", [], cache)[0]?.name, "renamed");
});

test("env creation, rewrites, local overrides and envMode invalidate the parsed values", (t) => {
  const { roots, settings, cache, config, app } = fixture(t);
  rewrite(
    config,
    'export default { name: "widget", manifest: true, server: { port: process.env.PORT } };\n',
  );
  const load = (mode = "development") => loadKnownApps(roots, settings, mode, [], cache)[0];
  assert.equal(load()?.port, null);
  rewrite(path.join(app, ".env.development"), "PORT=4100\n");
  assert.equal(load()?.port, 4100);
  rewrite(path.join(app, ".env.development"), "PORT=4200\n");
  assert.equal(load()?.port, 4200);
  rewrite(path.join(app, ".env.development.local"), "PORT=4300\n");
  assert.equal(load()?.port, 4300);
  rewrite(path.join(app, ".env.production"), "PORT=4400\n");
  assert.equal(load("production")?.port, 4400);
  assert.equal(load()?.port, 4300);
});

test("the imported federation helper recorded as configFile participates in the cache stamp", (t) => {
  const { roots, settings, cache, config, app } = fixture(t);
  fs.writeFileSync(path.join(app, "package.json"), "{}");
  const helper = path.join(app, "options.ts");
  rewrite(helper, 'export function federation() { return { name: "widget", manifest: true }; }');
  rewrite(
    config,
    'import { federation } from "./options"; createModuleFederationConfig(federation());',
  );
  const first = loadKnownApps(roots, settings, "development", [], cache)[0];
  assert.equal(first?.configFile, helper);
  assert.equal(first?.name, "widget");
  rewrite(helper, 'export function federation() { return { name: "changed", manifest: true }; }');
  assert.equal(loadKnownApps(roots, settings, "development", [], cache)[0]?.name, "changed");
});

test("manifest overrides are applied independently of the cached parse", (t) => {
  const { roots, settings, cache } = fixture(t);
  const load = (manifestPath?: string) =>
    loadKnownApps(
      roots,
      { widget: { ...settings.widget, manifestPath } },
      "development",
      [],
      cache,
    )[0];
  assert.equal(load("/first.json")?.manifestPath, "/first.json");
  assert.equal(load("/second.json")?.manifestPath, "/second.json");
  assert.equal(load()?.manifestPath, "/mf-manifest.json");
});

test("two configured app names sharing a folder retain their own cached identity", (t) => {
  const { roots, config, cache, app } = fixture(t);
  rewrite(config, 'export default { name: "alpha", manifest: true };');
  fs.writeFileSync(
    path.join(app, "rsbuild.config.ts"),
    'export default { name: "beta", manifest: true };',
  );
  const settings = { alpha: { path: "apps/widget" }, beta: { path: "apps/widget" } };
  assert.deepEqual(
    loadKnownApps(roots, settings, "development", [], cache).map((item) => item.name),
    ["alpha", "beta"],
  );
  assert.deepEqual(
    loadKnownApps(roots, settings, "development", [], cache).map((item) => item.name),
    ["alpha", "beta"],
  );
});

test("known app paths cannot leave the workspace through traversal or symlinks", (t) => {
  const { root, app, cache } = fixture(t);
  const sibling = path.join(root, "apps", "other");
  fs.symlinkSync(app, sibling, "dir");
  const roots = [{ name: "root", path: path.join(root, "confined") }];
  fs.mkdirSync(roots[0].path);
  fs.symlinkSync(app, path.join(roots[0].path, "escape"), "dir");
  assert.deepEqual(
    loadKnownApps(roots, { widget: { path: "../apps/widget" } }, "development", [], cache),
    [],
  );
  assert.deepEqual(
    loadKnownApps(roots, { widget: { path: "escape" } }, "development", [], cache),
    [],
  );
  assert.equal(
    loadKnownApps(
      [{ name: "root", path: root }],
      { widget: { path: "apps/other" } },
      "development",
      [],
      cache,
    )[0]?.name,
    "widget",
  );
});
