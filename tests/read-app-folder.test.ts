import { createLogger } from "../src/shared/logging.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readAppFolder, scanWorkspace } from "../src/entities/microfrontend/discover.ts";
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

test("launch config and explicit override use the app root and track local JSON", (t) => {
  const { root, app, config, roots, cache } = fixture(t);
  fs.unlinkSync(config);
  fs.unlinkSync(path.join(app, "src", "module-federation.config.ts"));
  const settings = { compass: { path: "apps/widget" } };
  fs.mkdirSync(path.join(app, "build-settings"));
  const json = path.join(app, "build-settings", "network.json");
  const nested = path.join(app, "build-settings", "rsbuild.config.ts");
  rewrite(json, '{"port":4617}');
  rewrite(
    nested,
    `import network from './network.json' with { type: 'json' };
    export default defineConfig(({ command }) => ({
      server: { port: command === 'dev' ? network.port : 4618 },
      plugins: [pluginModuleFederation({ name: 'compass', dts: true })],
    }));`,
  );
  rewrite(
    path.join(app, "package.json"),
    '{"scripts":{"dev":"rsbuild dev -c build-settings/rsbuild.config.ts"}}',
  );
  const discovered = scanWorkspace(root);
  assert.deepEqual(Object.keys(discovered), ["compass"]);
  assert.deepEqual(Object.keys(scanWorkspace(root, { ignorePaths: ["build-settings"] })), []);
  assert.equal(discovered.compass.folder, app);
  assert.equal(discovered.compass.generatedZipPath, path.join(app, "dist", "@mf-types.zip"));
  const load = () => loadKnownApps(roots, settings, "development", [], cache)[0];
  assert.equal(load()?.port, 4617);
  rewrite(json, '{"port":4621}');
  assert.equal(load()?.port, 4621);

  const override = { compass: { ...settings.compass, configFile: "custom.cjs" } };
  assert.deepEqual(loadKnownApps(roots, override, "development", [], cache), []);
  rewrite(
    path.join(app, "custom.cjs"),
    `const {port} = require('./build-settings/network.json');
    module.exports = { name: 'compass', server: { port: port + 2 } };`,
  );
  assert.equal(loadKnownApps(roots, override, "development", [], cache)[0]?.port, 4623);
  assert.equal(load()?.port, 4621);
  fs.symlinkSync(app, path.join(app, "alias"), "dir");
  const linked = { compass: { ...settings.compass, configFile: "alias/custom.cjs" } };
  assert.deepEqual(loadKnownApps(roots, linked, "development", [], cache), []);
});

test("a large JSON array spread does not interrupt workspace discovery", (t) => {
  const { root, app, config } = fixture(t);
  rewrite(path.join(app, "ports.json"), JSON.stringify([...Array(129999).fill(0), 4670]));
  rewrite(
    config,
    `import ports from './ports.json' with { type: 'json' };
    const listeners = [...ports];
    export default { name: 'widget', server: { port: listeners[129999] } };`,
  );
  const found = scanWorkspace(root);
  assert.deepEqual(Object.keys(found).sort(), ["nested", "widget"]);
  assert.equal(found.widget.port, 4670);

  rewrite(
    config,
    `import ports from './ports.json' with { type: 'json' };
    const pair = [...ports, ...ports];
    const listeners = [...pair, ...pair, ...pair];
    export default { name: 'widget', server: { port: listeners[129999] } };`,
  );
  const bounded = scanWorkspace(root);
  assert.deepEqual(Object.keys(bounded).sort(), ["nested", "widget"]);
  assert.equal(bounded.widget.port, null);
});

test("the selected config owns its federation options when a standalone config has the same name", (t) => {
  const { app, config, roots, settings, cache } = fixture(t);
  const selected = path.join(app, "rsbuild.selected.ts");
  rewrite(
    config,
    'export default { name: "widget", dts: false, remotes: { lib: "lib@https://assets.example.test/mf-manifest.json" } };',
  );
  rewrite(
    selected,
    `export default {
      server: { port: 4637 },
      plugins: [pluginModuleFederation({ name: "widget", dts: true,
        remotes: { lib: "lib@http://localhost:4638/mf-manifest.json" }
      })]
    };`,
  );
  const override = { widget: { ...settings.widget, configFile: "rsbuild.selected.ts" } };
  const load = () => loadKnownApps(roots, override, "development", [], cache)[0];
  const found = load();
  assert.equal(found?.configFile, selected);
  assert.equal(found.buildConfigFile, selected);
  assert.equal(found.port, 4637);
  assert.equal(found.generateTypes, true);
  assert.equal(found.remotes[0]?.url, "http://localhost:4638/mf-manifest.json");

  rewrite(selected, 'export default { server: { port: 4639, base: "/fixture/" } };');
  const fallback = load();
  assert.equal(fallback?.configFile, config);
  assert.equal(fallback.port, 4639);
  assert.equal(fallback.manifestPath, "/fixture/mf-manifest.json");

  rewrite(selected, "export default {");
  assert.equal(load(), undefined);
  rewrite(selected, " ".repeat(1024 * 1024 + 1));
  assert.equal(load(), undefined);
});

test("an explicit custom filename infers the Rsbuild context from defineConfig", (t) => {
  const { app, config, roots, settings, cache } = fixture(t);
  fs.unlinkSync(config);
  const pkg = path.join(app, "package.json");
  rewrite(pkg, '{"scripts":{"dev":"node tools/serve.mjs"}}');
  rewrite(path.join(app, ".env.development"), "FIXTURE_PORT=4643\nFIXTURE_ENABLED=yes\n");
  rewrite(
    path.join(app, "build-options.ts"),
    `import { defineConfig as configure } from "@rsbuild/core";
    import { pluginModuleFederation } from "@module-federation/rsbuild-plugin";
    const config = configure(({ command, envMode }) => {
      if (command !== "dev") return {};
      return {
        server: { port: Number(process.env.FIXTURE_PORT) + (envMode === "review" ? 1 : 0), base: "/fixture/" },
        plugins: [pluginModuleFederation({ name: "widget", manifest: { fileName: "entry" } })]
      };
    });
    export default process.env.FIXTURE_ENABLED === "yes" ? config : {};`,
  );
  const override = { widget: { ...settings.widget, configFile: "build-options.ts" } };
  const load = () => loadKnownApps(roots, override, "development", [], cache)[0];
  const found = load();
  assert.equal(found?.port, 4643);
  assert.equal(found.manifestPath, "/fixture/entry.json");

  rewrite(
    pkg,
    '{"scripts":{"dev":"cross-env FIXTURE_PORT=4645 vite build --mode review --config other.ts"}}',
  );
  const withViteScript = load();
  assert.equal(withViteScript?.port, 4643);
  assert.equal(withViteScript.launchEnvironment, undefined);

  rewrite(path.join(app, ".env.development"), "FIXTURE_PORT=4643\n");
  rewrite(
    pkg,
    '{"scripts":{"dev":"cross-env FIXTURE_PORT=4645 FIXTURE_ENABLED=yes rsbuild dev --env-mode review --config other.ts"}}',
  );
  assert.equal(load()?.port, 4646);
});

test("an explicit config can select the launch bundler from its script environment", (t) => {
  const { app, config, roots, settings } = fixture(t);
  fs.unlinkSync(config);
  rewrite(
    path.join(app, "package.json"),
    '{"scripts":{"dev":"cross-env FIXTURE_BUNDLER=rsbuild rsbuild dev --config build-options.ts"}}',
  );
  rewrite(
    path.join(app, "build-options.ts"),
    `import { defineConfig as rsbuildConfig } from "@rsbuild/core";
    import { defineConfig as viteConfig } from "vite";
    import { pluginModuleFederation } from "@module-federation/rsbuild-plugin";
    import { federation } from "@module-federation/vite";
    export default process.env.FIXTURE_BUNDLER === "rsbuild"
      ? rsbuildConfig({ server: { port: 4665 }, plugins: [pluginModuleFederation({ name: "widget" })] })
      : viteConfig({ server: { port: 4666 }, plugins: [federation({ name: "widget" })] });`,
  );
  const [automatic] = loadKnownApps(roots, settings, "development");
  const override = { widget: { ...settings.widget, configFile: "build-options.ts" } };
  const [explicit] = loadKnownApps(roots, override, "development");
  assert.equal(automatic?.port, 4665);
  assert.equal(explicit?.port, automatic.port);
  assert.equal(explicit.launchEnvironment?.env.FIXTURE_BUNDLER, "rsbuild");
});

test("a helper's defineConfig does not change the bundler of the exported config", (t) => {
  const { app, config, roots, settings } = fixture(t);
  fs.unlinkSync(config);
  rewrite(
    path.join(app, "package.json"),
    '{"scripts":{"dev":"cross-env FIXTURE_PORT=4668 rsbuild dev --env-mode review --config rsbuild.options.ts"}}',
  );
  rewrite(path.join(app, ".env.development"), "FIXTURE_PORT=4667\n");
  rewrite(
    path.join(app, "rsbuild.options.ts"),
    `import { defineConfig as viteConfig } from "vite";
    import { pluginModuleFederation } from "@module-federation/rsbuild-plugin";
    const shared = viteConfig({ server: { port: Number(process.env.FIXTURE_PORT) } });
    export default {
      ...shared,
      server: { ...shared.server, base: "/fixture/" },
      plugins: [pluginModuleFederation({ name: "widget", manifest: { fileName: "entry" } })]
    };`,
  );
  const override = { widget: { ...settings.widget, configFile: "rsbuild.options.ts" } };
  const [found] = loadKnownApps(roots, override, "development");
  assert.equal(found?.port, 4668);
  assert.equal(found.manifestPath, "/fixture/entry.json");
  assert.equal(found.launchEnvironment?.envMode, "review");
});

test("a spread of an exported Rsbuild config keeps the manifest route", (t) => {
  const { app, config, roots, settings } = fixture(t);
  fs.unlinkSync(config);
  rewrite(path.join(app, "package.json"), '{"scripts":{"dev":"node tools/start.mjs"}}');
  rewrite(
    path.join(app, "build-options.ts"),
    `import { defineConfig } from "@rsbuild/core";
    import { pluginModuleFederation } from "@module-federation/rsbuild-plugin";
    const base = defineConfig({
      server: { port: 4669, base: "/fixture/" },
      plugins: [pluginModuleFederation({ name: "widget", manifest: { fileName: "entry" } })]
    });
    export default { ...base, html: { title: "Fixture" } };`,
  );
  const override = { widget: { ...settings.widget, configFile: "build-options.ts" } };
  const [found] = loadKnownApps(roots, override, "development");
  assert.equal(found?.port, 4669);
  assert.equal(found.manifestPath, "/fixture/entry.json");
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

test("a selected startup script and a confined profile supply ports and conditional remotes", (t) => {
  const { app, config, roots, cache } = fixture(t);
  fs.unlinkSync(config);
  const pkg = path.join(app, "package.json");
  const profile = path.join(app, ".env.staging.preview");
  rewrite(
    pkg,
    JSON.stringify({
      scripts: {
        dev: "rsbuild dev",
        preview: "cross-env DEPLOY_LANE=staging.preview rsbuild dev",
      },
    }),
  );
  rewrite(profile, "HTTP_LISTENER=4621\nSHOW_ICONS=yes\n");
  rewrite(
    path.join(app, "rsbuild.config.ts"),
    `
    import disk from 'node:fs';
    import locations from 'node:path';
    import codec from 'dotenv';
    const filename = () => {
      switch (process.env.DEPLOY_LANE) {
        case 'review.preview':
        case 'staging.preview': return locations.resolve(__dirname, '.env.staging.preview');
        default: return undefined;
      }
    };
    const settings = () => {
      const selected = filename();
      const values = selected ? codec.parse(disk.readFileSync(selected, { encoding: 'utf-8' })) : {};
      return { ...values, lane: process.env.DEPLOY_LANE };
    };
    const profile = settings();
    const links = { shapes: 'shapes@http://localhost:4622/mf-manifest.json' };
    if (profile.SHOW_ICONS) links.icons = 'icons@http://localhost:4623/mf-manifest.json';
    export default defineConfig(() => ({
      server: { port: Number(process.env.LISTEN_OVERRIDE || profile.HTTP_LISTENER || 4620) },
      plugins: [pluginModuleFederation({ name: 'sketchbook', remotes: links })],
    }));
  `,
  );
  const load = (start: string) =>
    loadKnownApps(
      roots,
      { sketchbook: { path: "apps/widget", scripts: { start } } },
      "development",
      [],
      cache,
    )[0];
  assert.equal(load("dev")?.port, 4620);
  assert.equal(load("preview")?.port, 4621);
  assert.deepEqual(
    load("preview")?.remotes.map((remote) => remote.name),
    ["shapes", "icons"],
  );
  rewrite(profile, "HTTP_LISTENER=4631\n");
  assert.equal(load("preview")?.port, 4631);
  assert.deepEqual(
    load("preview")?.remotes.map((remote) => remote.name),
    ["shapes"],
  );
  rewrite(
    pkg,
    JSON.stringify({ scripts: { preview: "cross-env LISTEN_OVERRIDE=4641 rsbuild dev" } }),
  );
  assert.equal(load("preview")?.port, 4641);
});

test("a Vite start script supplies the mode without injecting mode files into process.env", (t) => {
  const { app, config, roots, settings, cache } = fixture(t);
  fs.unlinkSync(config);
  const pkg = path.join(app, "package.json");
  rewrite(pkg, '{"scripts":{"dev":"vite --mode review.preview"}}');
  const envFile = path.join(app, ".env.review.preview");
  rewrite(envFile, "LISTENER=4617\n");
  rewrite(
    path.join(app, "vite.config.ts"),
    `export default defineConfig(({ mode, command, isPreview }) => ({
    plugins: [pluginModuleFederation({name: 'widget'})],
    server: {port: mode === 'production' ? (isPreview ? 4623 : 4622)
      : command === 'serve' && isPreview ? 4621
      : command === 'build' ? 4620
      : mode === 'review.preview' ? parseInt(process.env.LISTENER ?? '4616', 10) : 4618},
  }));`,
  );
  const load = () => loadKnownApps(roots, settings, "development", [], cache)[0];
  assert.equal(load()?.port, 4616);
  rewrite(pkg, '{"scripts":{"dev":"cross-env LISTENER=4619 vite --mode review.preview"}}');
  assert.equal(load()?.port, 4619);
  rewrite(pkg, '{"scripts":{"dev":"vite build --mode review.preview"}}');
  assert.equal(load()?.port, 4620);
  rewrite(pkg, '{"scripts":{"dev":"vite --strictPort preview build --mode review.preview"}}');
  assert.equal(load()?.port, 4621);
  rewrite(pkg, '{"scripts":{"dev":"cross-env NODE_ENV=development vite build"}}');
  assert.equal(load()?.port, 4622);
  rewrite(pkg, '{"scripts":{"dev":"vite --strictPort --port 4173 preview"}}');
  assert.equal(load()?.port, 4623);
});

test("Vite config sees the command's default NODE_ENV independently of --mode", (t) => {
  const { app, config, roots, settings, cache } = fixture(t);
  fs.unlinkSync(config);
  rewrite(path.join(app, ".env.review"), "NODE_ENV=unrelated\n");
  rewrite(
    path.join(app, "vite.config.ts"),
    `export default defineConfig({
      plugins: [pluginModuleFederation({ name: "widget" })],
      server: { port: process.env.NODE_ENV === "development" ? 4661
        : process.env.NODE_ENV === "production" ? 4662
        : process.env.NODE_ENV === "fixture" ? 4663 : 4664 },
    });`,
  );
  for (const [script, port] of [
    ["vite --mode review", 4661],
    ["vite --mode build", 4661],
    ["vite build --mode review", 4662],
    ["vite --mode review build", 4662],
    ["vite preview --mode review", 4662],
    ["vite --mode review preview", 4662],
    ["vite -c vite.config.ts -m review build", 4662],
    ["vite --strictPort --port 4173 preview", 4662],
    ["vite --clearScreen false --outDir preview build", 4662],
    ["cross-env NODE_ENV=fixture vite --mode review", 4663],
  ] as const) {
    rewrite(path.join(app, "package.json"), JSON.stringify({ scripts: { dev: script } }));
    assert.equal(loadKnownApps(roots, settings, "development", [], cache)[0]?.port, port, script);
  }
});

test("Rsbuild launch can disable automatic env files", (t) => {
  const { app, config, roots, settings, cache } = fixture(t);
  fs.unlinkSync(config);
  rewrite(path.join(app, "package.json"), '{"scripts":{"dev":"rsbuild dev --no-env"}}');
  rewrite(path.join(app, ".env.development"), "LISTENER=4600\n");
  rewrite(
    path.join(app, "rsbuild.config.ts"),
    'export default { name:"widget", server:{port:Number(process.env.LISTENER || 4601)} };',
  );
  assert.equal(loadKnownApps(roots, settings, "development", [], cache)[0]?.port, 4601);
});

test("Rsbuild config sees the command's default NODE_ENV and preserves explicit generation env", (t) => {
  const { app, config, roots, settings, cache } = fixture(t);
  fs.unlinkSync(config);
  rewrite(
    path.join(app, "rsbuild.config.ts"),
    `export default defineConfig(({ env }) => ({
      name: 'widget',
      server: { port: env !== process.env.NODE_ENV ? 4674
        : env === 'development' ? 4671 : env === 'production' ? 4672 : 4673 },
    }));`,
  );
  rewrite(path.join(app, ".env.review"), "NODE_ENV=review\n");
  for (const [script, port, nodeEnv] of [
    ["rsbuild dev --no-env", 4671, undefined],
    ["rsbuild build", 4672, undefined],
    ["rsbuild -c rsbuild.config.ts build", 4672, undefined],
    ["rsbuild -w build", 4672, undefined],
    ["rsbuild --port 4173 preview", 4672, undefined],
    ["rsbuild --env-mode build", 4671, undefined],
    ["cross-env NODE_ENV=fixture rsbuild dev", 4673, "fixture"],
    ["rsbuild dev --env-mode review", 4673, "review"],
  ] as const) {
    rewrite(path.join(app, "package.json"), JSON.stringify({ scripts: { dev: script } }));
    const [found] = loadKnownApps(roots, settings, "development", [], cache);
    assert.equal(found?.port, port, script);
    assert.equal(found.launchEnvironment?.env.NODE_ENV, nodeEnv, script);
  }
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
  const { roots, settings, cache, app } = fixture(t);
  fs.writeFileSync(
    path.join(app, "rsbuild.config.ts"),
    `export default {
      dev: { assetPrefix: "/fixture-assets/" },
      plugins: [pluginModuleFederation({ name: "widget", manifest: true })]
    };`,
  );
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
  assert.equal(load("/mf-manifest.json")?.devManifestPath, undefined);
  assert.equal(load()?.manifestPath, "/mf-manifest.json");
  assert.equal(load()?.devManifestPath, "/fixture-assets/mf-manifest.json");
});

test("changing or removing an intermediate re-export invalidates the parsed config", (t) => {
  const { roots, settings, cache, config, app } = fixture(t);
  fs.writeFileSync(path.join(app, "package.json"), "{}");
  const barrel = path.join(app, "barrel.ts");
  const nested = path.join(app, "src", "nested.ts");
  rewrite(
    config,
    'import { federation } from "./barrel"; createModuleFederationConfig(federation());',
  );
  rewrite(barrel, 'export { federation } from "./src/nested";');
  rewrite(nested, 'export { federation } from "../old";');
  for (const [file, remote, port] of [
    ["old", "one", 3001],
    ["new", "two", 3002],
  ] as const) {
    rewrite(
      path.join(app, `${file}.ts`),
      `export function federation() { return { name: "widget", manifest: true, remotes: { remote: "${remote}@http://localhost:${port}/mf-manifest.json" } }; }`,
    );
  }
  const load = () => loadKnownApps(roots, settings, "development", [], cache)[0];
  assert.equal(load()?.remotes[0].name, "one");
  const read = t.mock.method(fs, "readFileSync");
  assert.equal(load()?.remotes[0].name, "one");
  assert.equal(read.mock.callCount(), 0, "unchanged import chains do not reread bytes");
  rewrite(nested, 'export { federation } from "../new";');
  assert.equal(load()?.remotes[0].name, "two");
  assert.equal(load()?.configFile, path.join(app, "new.ts"));
  fs.unlinkSync(nested);
  assert.equal(load(), undefined);
  rewrite(nested, 'export { federation } from "../old";');
  assert.equal(load()?.remotes[0].name, "one");
});

test("creating a higher priority import candidate invalidates the parsed config", (t) => {
  const { roots, settings, cache, config, app } = fixture(t);
  fs.writeFileSync(path.join(app, "package.json"), "{}");
  rewrite(
    config,
    'import { federation } from "./options"; createModuleFederationConfig(federation());',
  );
  rewrite(
    path.join(app, "options.js"),
    'export function federation() { return { name: "widget", dts: false }; }',
  );
  const load = () => loadKnownApps(roots, settings, "development", [], cache)[0];
  assert.equal(load()?.generateTypes, false);
  rewrite(
    path.join(app, "options.ts"),
    'export function federation() { return { name: "widget", dts: true }; }',
  );
  assert.equal(load()?.generateTypes, true);
  assert.equal(load()?.configFile, path.join(app, "options.ts"));
});

test("changes in a star re-export invalidate the chosen helper and expose ambiguity", (t) => {
  const { roots, settings, cache, config, app } = fixture(t);
  fs.writeFileSync(path.join(app, "package.json"), "{}");
  rewrite(
    config,
    'import { federation } from "./barrel"; createModuleFederationConfig(federation());',
  );
  rewrite(path.join(app, "barrel.ts"), 'export * from "./first"; export * from "./second";');
  rewrite(path.join(app, "first.ts"), "export const unrelated = 1;");
  rewrite(
    path.join(app, "second.ts"),
    'export function federation() { return { name: "widget", dts: false }; }',
  );
  const load = () => loadKnownApps(roots, settings, "development", [], cache)[0];
  assert.equal(load()?.generateTypes, false);
  rewrite(
    path.join(app, "first.ts"),
    'export function federation() { return { name: "widget", dts: true }; }',
  );
  assert.equal(load(), undefined);
  rewrite(
    path.join(app, "barrel.ts"),
    'export { federation } from "./first"; export * from "./second";',
  );
  assert.equal(load()?.generateTypes, true);
  assert.equal(load()?.configFile, path.join(app, "first.ts"));
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

test("stale app settings cannot claim an ambiguous or already configured name", (t) => {
  const { roots, config, cache, app } = fixture(t);
  const other = path.join(app, "rsbuild.config.ts");
  rewrite(config, 'export default { name: "compass", manifest: true };');
  rewrite(other, 'export default { name: "atlas", manifest: true };');
  const folder = { path: "apps/widget" };
  const old = { ...folder, manifestPath: "/obsolete.json" };
  const settings = { retired: old, atlas: folder, compass: folder };

  assert.equal(readAppFolder(app, "development", "retired"), null);
  assert.deepEqual(
    loadKnownApps(roots, settings, "development", [], cache).map(({ name }) => name),
    ["atlas", "compass"],
  );

  fs.unlinkSync(other);
  const load = () => loadKnownApps(roots, settings, "development", [], cache);
  for (const result of [load(), load()])
    assert.deepEqual(
      result.map(({ name, manifestPath }) => [name, manifestPath]),
      [["compass", "/mf-manifest.json"]],
    );
  assert.deepEqual(loadKnownApps(roots, { retired: old, archived: folder }, "development"), []);
});

test("a renamed app in another folder remains visible to duplicate-name checks", (t) => {
  const { root, app, roots, settings } = fixture(t);
  const other = path.join(root, "apps", "other");
  fs.mkdirSync(other);
  rewrite(path.join(other, "module-federation.config.ts"), 'export default { name: "widget" };');
  const found = loadKnownApps(
    roots,
    { retired: { path: "apps/other" }, ...settings },
    "development",
  );
  assert.deepEqual(
    found.map(({ name, folder }) => [name, folder]),
    [
      ["widget", other],
      ["widget", app],
    ],
  );
});

test("a stale key using another path to the same app does not create a duplicate", (t) => {
  const { root, app, roots, settings } = fixture(t);
  fs.symlinkSync(app, path.join(root, "apps", "alias"), "dir");
  const found = loadKnownApps(
    roots,
    { retired: { path: "apps/alias" }, ...settings },
    "development",
  );
  assert.deepEqual(
    found.map(({ name, folder }) => [name, folder]),
    [["widget", app]],
  );
  if (fs.existsSync(path.join(root, "apps", "WIDGET"))) {
    const withCaseAlias = loadKnownApps(
      roots,
      { retired: { path: "apps/WIDGET" }, ...settings },
      "development",
    );
    assert.deepEqual(
      withCaseAlias.map(({ folder }) => folder),
      [app],
    );
  }
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

test("cache diagnostics observe changed reexports without reading unchanged bytes", (t) => {
  const { roots, settings, config, app } = fixture(t);
  const messages: string[] = [];
  const log = createLogger({ enabled: () => true, write: (_level, text) => messages.push(text) });
  const cache = createAppParseCache(log);
  fs.writeFileSync(path.join(app, "package.json"), "{}");
  rewrite(
    config,
    'import { federation } from "./barrel"; createModuleFederationConfig(federation());',
  );
  const barrel = path.join(app, "barrel.ts");
  rewrite(barrel, 'export { federation } from "./one";');
  rewrite(path.join(app, "one.ts"), 'export function federation() { return { name: "widget" }; }');
  rewrite(path.join(app, "two.ts"), 'export function federation() { return { name: "renamed" }; }');
  const load = () => loadKnownApps(roots, settings, "development", [], cache, log)[0];
  assert.equal(load()?.name, "widget");
  const read = t.mock.method(fs, "readFileSync");
  assert.equal(load()?.name, "widget");
  assert.equal(read.mock.callCount(), 0);
  rewrite(barrel, 'export { federation } from "./two";');
  assert.equal(load()?.name, "renamed");
  assert.equal(messages.filter((text) => text.startsWith("config.cache.miss")).length, 2);
  assert.equal(messages.filter((text) => text.startsWith("config.cache.hit")).length, 1);
  assert.ok(messages.some((text) => text.includes("reason=import-dependency-changed")));
});
