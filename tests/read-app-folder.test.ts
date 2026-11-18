import { createLogger } from "../src/shared/lib/logging.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readAppFolder, scanWorkspace } from "../src/entities/microfrontend/lib/discover.ts";
import { createAppParseCache } from "../src/widgets/mf-dashboard-tree/lib/app-parse-cache.ts";
import { loadKnownApps } from "../src/widgets/mf-dashboard-tree/lib/known-apps.ts";
import { developmentFederationConfig } from "./support/app.ts";

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

test("Rslib discovers a configured package and dotenv directory through filesystem case aliases", (t) => {
  const { root, roots } = fixture(t);
  const folder = path.join(root, "DesignSystem");
  const profiles = path.join(folder, "Profiles");
  fs.mkdirSync(profiles, { recursive: true });
  rewrite(
    path.join(folder, "package.json"),
    '{"scripts":{"dev":"rslib mf-dev --env-dir Profiles"}}',
  );
  rewrite(path.join(profiles, ".env"), "FIXTURE_MF_NAME=designSystem\nFIXTURE_PORT=4651\n");
  rewrite(
    path.join(folder, "rslib.config.ts"),
    `export default { server: { port: process.env.FIXTURE_PORT },
      lib: [{ format: 'mf', plugins: [pluginModuleFederation({ name: process.env.FIXTURE_MF_NAME })] }]
    };`,
  );
  const load = (location: string) =>
    loadKnownApps(roots, { designSystem: { path: location } }, "development");
  assert.equal(load("DesignSystem")[0]?.port, 4651);
  if (fs.existsSync(path.join(root, "designsystem", "profiles"))) {
    rewrite(
      path.join(folder, "package.json"),
      '{"scripts":{"dev":"rslib mf-dev --env-dir profiles"}}',
    );
    const [app] = load("designsystem");
    assert.equal(app?.name, "designSystem");
    assert.equal(app.port, 4651);
    assert.equal(app.launchEnvironment?.configDirectory?.path, fs.realpathSync.native(folder));
  } else {
    assert.deepEqual(load("designsystem"), []);
  }
});

test("Discover recognizes the canonical name of an explicitly configured Rslib file", (t) => {
  const { app, config, roots, settings, cache } = fixture(t);
  fs.unlinkSync(config);
  const actual = path.join(app, "rslib.config.ts");
  rewrite(
    actual,
    `export default {lib:[{format:'mf',plugins:[pluginModuleFederation({name:'widget'})]}]};`,
  );
  const load = (configFile: string) =>
    loadKnownApps(
      roots,
      { widget: { ...settings.widget, configFile } },
      "development",
      [],
      cache,
    )[0];
  assert.equal(load("rslib.config.ts")?.rslibConfigFile, actual);
  for (const alias of ["RSLIB.config.ts", "RSLIB.CONFIG.TS"]) {
    if (fs.existsSync(path.join(app, alias))) {
      const found = load(alias);
      assert.equal(found?.name, "widget");
      assert.equal(found.rslibConfigFile, actual);
    } else {
      assert.equal(load(alias), undefined);
    }
  }
});

test("Discover invalidates inherited dotenv when a dangling package marker appears", (t) => {
  const { app, config, roots, settings, cache } = fixture(t);
  fs.unlinkSync(config);
  const folder = path.join(app, "config");
  fs.mkdirSync(folder);
  rewrite(
    path.join(app, "package.json"),
    '{"scripts":{"dev":"rslib mf-dev --config config/rslib.config.ts"}}',
  );
  rewrite(path.join(app, ".env.local"), "FIXTURE_PORT=4310\n");
  rewrite(
    path.join(folder, "rslib.config.ts"),
    `export default {lib:[{format:'mf',plugins:[pluginModuleFederation({name:'widget',
      remotes:{ library: \`library@http://localhost:\${process.env.FIXTURE_PORT}/mf-manifest.json\` }
    })]}]};`,
  );
  const load = (appCache = cache) => loadKnownApps(roots, settings, "development", [], appCache)[0];
  const url = "http://localhost:4310/mf-manifest.json";
  assert.equal(load()?.remotes[0]?.url, url);
  const marker = path.join(folder, "package.json");
  fs.symlinkSync("missing.json", marker, "file");
  assert.equal(load(createAppParseCache())?.remotes[0]?.url, null);
  assert.equal(load()?.remotes[0]?.url, null);
  fs.unlinkSync(marker);
  assert.equal(load()?.remotes[0]?.url, url);
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

test("a custom Vite config remains selectable when the start script runs Rslib", (t) => {
  const { app, roots, settings } = fixture(t);
  fs.writeFileSync(path.join(app, "package.json"), '{"scripts":{"dev":"rslib mf-dev"}}');
  const custom = path.join(app, "custom.ts");
  fs.writeFileSync(
    custom,
    `
    import { defineConfig } from 'vite';
    export default defineConfig(({ command }) => ({
      server: { port: command === 'serve' ? 4500 : 9000 },
      plugins: [pluginModuleFederation({ name: 'widget' })],
    }));
  `,
  );
  const [found] = loadKnownApps(
    roots,
    { widget: { ...settings.widget, configFile: "custom.ts" } },
    "development",
  );
  assert.equal(found?.configFile, custom);
  assert.equal(found.port, 4500);
  rewrite(path.join(app, "package.json"), '{"scripts":{"dev":"rslib mf-dev --root missing"}}');
  const [withMissingRoot] = loadKnownApps(
    roots,
    { widget: { ...settings.widget, configFile: "custom.ts" } },
    "development",
  );
  assert.equal(withMissingRoot?.configFile, custom);
  assert.equal(withMissingRoot.port, 4500);
});

test("explicitly selecting the script's custom config preserves its Rslib context", (t) => {
  const { app, roots, settings, cache } = fixture(t);
  rewrite(
    path.join(app, "package.json"),
    '{"scripts":{"dev":"cross-env PROFILE=mf rslib mf-dev -c custom.ts --env-mode review"}}',
  );
  rewrite(path.join(app, "tsconfig.json"), "{}");
  const config = path.join(app, "custom.ts");
  rewrite(
    config,
    `export default {
      plugins: [pluginModuleFederation({ name: 'widget', exposes: { '.': './index.ts' } })],
      lib: [{ format: process.env.PROFILE ?? 'esm' }],
    };`,
  );
  const [automatic] = loadKnownApps(roots, settings, "development", [], cache);
  const override = { widget: { ...settings.widget, configFile: "./custom.ts" } };
  const [explicit] = loadKnownApps(roots, override, "development", [], cache);
  assert.deepEqual(explicit, automatic);
  assert.equal(explicit?.bundler, "rslib");
  assert.equal(explicit.port, 3000);
  assert.equal(explicit.manifest, true);
  assert.equal(explicit.generateTypes, true);
  assert.equal(explicit.buildConfigFile, config);
  assert.equal(explicit.launchEnvironment?.envMode, "review");
  rewrite(
    path.join(app, "package.json"),
    '{"scripts":{"dev":"cross-env PROFILE=mf rslib mf-dev --env-mode review"}}',
  );
  const [withDefaultScript] = loadKnownApps(roots, override, "development", [], cache);
  assert.equal(withDefaultScript?.bundler, explicit.bundler);
  assert.equal(withDefaultScript.port, explicit.port);
  assert.equal(withDefaultScript.generateTypes, explicit.generateTypes);
  assert.equal(withDefaultScript.manifest, explicit.manifest);
  assert.deepEqual(withDefaultScript.launchEnvironment, explicit.launchEnvironment);
});

test("configured helper ownership follows the final root after a fallback", (t) => {
  const { root, cache } = fixture(t);
  const roots = ["first", "second"].map((name) => ({ name, path: path.join(root, name) }));
  for (const { path: workspace } of roots) {
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, "package.json"), "{}");
  }
  const [first, second] = roots.map(({ path }) => path);
  for (const [name, next] of [["a", "b"], ["b", "c"], ["c", "d"], ["d"]]) {
    const folder = path.join(first, name);
    fs.mkdirSync(folder);
    fs.writeFileSync(
      path.join(folder, "module-federation.config.ts"),
      `export default {name:'${name}'}`,
    );
    if (!next) continue;
    fs.writeFileSync(path.join(folder, ".env"), "NODE_ENV=production\n");
    fs.writeFileSync(path.join(folder, "vite.config.ts"), "export default {};");
    fs.writeFileSync(
      path.join(folder, "rslib.config.ts"),
      developmentFederationConfig(`../${next}/module-federation.config`),
    );
    fs.mkdirSync(path.join(second, name));
    fs.writeFileSync(
      path.join(second, name, "vite.config.ts"),
      `export default {plugins:[pluginModuleFederation({name:'${name}'})]};`,
    );
  }
  const a = { path: "a", configFile: "vite.config.ts" };
  const b = { path: "b", configFile: "vite.config.ts" };
  const c = { path: "c", workspaceFolder: "first" };
  for (const apps of [
    { a, b, c },
    { b, a, c },
  ]) {
    const loaded = loadKnownApps(roots, apps, "development", ["a", "b"], cache);
    assert.deepEqual(
      Object.fromEntries(loaded.map(({ name, folder }) => [name, path.relative(root, folder)])),
      {
        a: path.join("first", "a"),
        b: path.join("second", "b"),
        c: path.join("first", "c"),
      },
    );
  }
  fs.writeFileSync(
    path.join(first, "b", "rslib.config.ts"),
    developmentFederationConfig("../a/module-federation.config"),
  );
  const explicitC = { path: "c", configFile: "vite.config.ts" };
  const d = { path: "d", workspaceFolder: "first" };
  const cyclicCases: Parameters<typeof loadKnownApps>[1][] = [
    { c: explicitC, d },
    { a, b, c: explicitC, d },
  ];
  for (const apps of cyclicCases) {
    const loaded = loadKnownApps(roots, apps, "development", ["a", "b", "c"], cache);
    assert.equal(loaded.find(({ name }) => name === "c")?.folder, path.join(first, "c"));
    assert.ok(!loaded.some(({ name }) => name === "d"));
  }
  fs.writeFileSync(
    path.join(first, "a", "module-federation.config.js"),
    `export default { name: 'a' };`,
  );
  const after = loadKnownApps(roots, { a, b }, "development", ["a", "b"], cache);
  assert.deepEqual(
    after.map(({ folder }) => folder),
    [path.join(first, "a"), path.join(second, "b")],
  );
});

test("a root without a matching app cannot create an ownership cycle", (t) => {
  const { root, cache } = fixture(t);
  const roots = ["first", "second"].map((name) => ({ name, path: path.join(root, name) }));
  rewrite(path.join(root, "package.json"), "{}");
  const [first, second] = roots.map(({ path }) => path);
  for (const name of ["a", "b"]) {
    const app = path.join(first, name);
    fs.mkdirSync(app, { recursive: true });
    rewrite(path.join(app, "module-federation.config.ts"), `export default { name: '${name}' };`);
    rewrite(path.join(app, "vite.config.ts"), "export default {};");
  }
  rewrite(
    path.join(first, "a", "rslib.config.ts"),
    developmentFederationConfig("../b/module-federation.config"),
  );
  const alternative = path.join(second, "b");
  fs.mkdirSync(alternative, { recursive: true });
  rewrite(path.join(alternative, "vite.config.ts"), "export default {};");
  const apps = {
    a: { path: "a", configFile: "vite.config.ts" },
    b: { path: "b", configFile: "vite.config.ts" },
  };
  const load = () =>
    loadKnownApps(roots, apps, "development", ["a", "b"], cache).map(({ name }) => name);
  assert.deepEqual(load(), ["a"]);
  rewrite(
    path.join(alternative, "rslib.config.ts"),
    developmentFederationConfig("../../first/a/module-federation.config"),
  );
  assert.deepEqual(load(), ["a"]);
});

test("a later candidate cannot block claims from its own selected app", (t) => {
  const { root, cache } = fixture(t);
  const roots = ["first", "second"].map((name) => ({ name, path: path.join(root, name) }));
  const [first, second] = roots.map(({ path }) => path);
  rewrite(path.join(root, "package.json"), "{}");
  for (const app of [path.join(first, "a"), path.join(first, "b"), path.join(second, "a")])
    fs.mkdirSync(app, { recursive: true });
  rewrite(path.join(first, "a", "vite.config.ts"), "export default {};");
  rewrite(path.join(first, "a", "module-federation.config.ts"), "export default {name:'a'};");
  rewrite(path.join(first, "b", "module-federation.config.ts"), "export default {name:'b'};");
  rewrite(
    path.join(first, "a", "rslib.config.ts"),
    developmentFederationConfig("../b/module-federation.config"),
  );
  rewrite(
    path.join(second, "a", "vite.config.ts"),
    "export default {plugins:[pluginModuleFederation({name:'a'})]};",
  );
  const apps = {
    a: { path: "a", configFile: "vite.config.ts" },
    b: { path: "b", workspaceFolder: "first" },
  };
  const load = () =>
    loadKnownApps(roots, apps, "development", ["a"], cache).map(({ folder }) => folder);
  assert.deepEqual(load(), [path.join(first, "a")]);
  rewrite(
    path.join(second, "a", "rslib.config.ts"),
    developmentFederationConfig("../../first/a/module-federation.config"),
  );
  assert.deepEqual(load(), [path.join(first, "a")]);
});

test("warm app refresh checks shared ownership inputs once per workspace", (t) => {
  const { root, roots, cache } = fixture(t);
  const workspacePackage = path.join(root, "package.json");
  fs.writeFileSync(workspacePackage, "{}");
  const workspaceOnly = path.join(root, "unrelated");
  fs.mkdirSync(workspaceOnly);
  const settings: Record<string, { path: string }> = {};
  for (const name of ["first", "second", "third"]) {
    const app = path.join(root, name);
    fs.mkdirSync(app);
    fs.writeFileSync(
      path.join(app, "module-federation.config.ts"),
      `export default { name: '${name}' };`,
    );
    settings[name] = { path: name };
  }
  const load = (apps = settings) => loadKnownApps(roots, apps, "development", [], cache);
  assert.equal(load().length, 3);
  const stat = t.mock.method(fs, "statSync");
  const read = t.mock.method(fs, "readFileSync");
  assert.equal(load().length, 3);
  assert.equal(stat.mock.calls.filter(({ arguments: [file] }) => file === workspaceOnly).length, 1);
  assert.equal(read.mock.callCount(), 0);
  stat.mock.resetCalls();
  assert.equal(load({ ...settings, widget: { path: "apps/widget" } }).length, 4);
  assert.equal(stat.mock.calls.filter(({ arguments: [file] }) => file === workspaceOnly).length, 1);
});

test("warm multi-root selection caches occupied, missing and mismatched configs", (t) => {
  const { root, cache } = fixture(t);
  const roots = ["missing", "other", "matching"].map((name) => ({
    name,
    path: path.join(root, name),
  }));
  const file = (index: number) => path.join(roots[index].path, "widget", "custom.ts");
  for (const candidate of roots.slice(1))
    fs.mkdirSync(path.join(candidate.path, "widget"), { recursive: true });
  rewrite(file(1), `export default { name: 'other' };`);
  rewrite(file(2), `export default { name: 'widget' };`);
  const load = () =>
    loadKnownApps(
      roots,
      { widget: { path: "widget", configFile: "custom.ts" } },
      "development",
      [],
      cache,
    );
  assert.equal(load()[0]?.configFile, file(2));
  const open = t.mock.method(fs, "openSync");
  assert.equal(load()[0]?.configFile, file(2));
  assert.equal(
    open.mock.calls.filter(({ arguments: [source] }) => String(source).endsWith("custom.ts"))
      .length,
    0,
  );
  fs.mkdirSync(path.dirname(file(0)), { recursive: true });
  rewrite(file(0), `export default { name: 'widget' };`);
  assert.equal(load()[0]?.configFile, file(0));
});

test(
  "the known app cache detects recovery after config permissions change",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  (t) => {
    const { app, roots, cache, settings } = fixture(t);
    const config = path.join(app, "custom.ts");
    fs.writeFileSync(config, `export default { name: 'widget' };`);
    fs.chmodSync(config, 0o000);
    const load = () =>
      loadKnownApps(
        roots,
        { widget: { ...settings.widget, configFile: "custom.ts" } },
        "development",
        [],
        cache,
      );
    assert.deepEqual(load(), []);
    fs.chmodSync(config, 0o600);
    assert.equal(load()[0]?.configFile, config);
  },
);

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

test("a change after reading config bytes does not cache the old config under the new stamp", (t) => {
  const { roots, settings, config, cache } = fixture(t);
  const openSync = fs.openSync;
  const readSync = fs.readSync;
  let configFd: number | undefined;
  let changed = false;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof openSync>) => {
    const fd: number = Reflect.apply(openSync, fs, args);
    if (!changed && args[0] === config) configFd = fd;
    return fd;
  });
  t.mock.method(fs, "readSync", (...args: Parameters<typeof readSync>) => {
    const count: number = Reflect.apply(readSync, fs, args);
    if (!changed && configFd === args[0] && count === 0) {
      changed = true;
      rewrite(config, 'export default { name: "updated", manifest: true, dts: false };\n');
    }
    return count;
  });

  const load = () => loadKnownApps(roots, settings, "development", [], cache)[0];
  assert.equal(load()?.name, "widget");
  assert.equal(changed, true);
  assert.equal(load()?.name, "updated");
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
