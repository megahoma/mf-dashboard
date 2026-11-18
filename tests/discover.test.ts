import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { serialize } from "node:v8";
import {
  configInputFingerprint,
  discoverSource,
  readAppFolder,
  readRslibEnv,
  scanWorkspace,
} from "../src/entities/microfrontend/index.ts";
import { UNKNOWN } from "../src/entities/microfrontend/config/config.ts";
import { ConfigImports } from "../src/entities/microfrontend/lib/config-imports.ts";
import {
  CONFIG_INPUT_LIMIT,
  readConfigDirectory,
  readConfigInput,
} from "../src/entities/microfrontend/lib/config-input.ts";
import { RslibEnvLimitError } from "../src/entities/microfrontend/lib/env-files.ts";
import { readLaunchScript } from "../src/entities/microfrontend/lib/launch-script.ts";
import { rslibDtsExposes } from "../src/entities/microfrontend/lib/rslib-config.ts";
import { parseProgram } from "../src/entities/microfrontend/lib/syntax.ts";
import { createLogger } from "../src/shared/lib/logging.ts";
import {
  createAppParseCache,
  savedFileKind,
} from "../src/widgets/mf-dashboard-tree/lib/app-parse-cache.ts";
import {
  loadKnownApps,
  previousRslibAppLocation,
} from "../src/widgets/mf-dashboard-tree/lib/known-apps.ts";
import { developmentFederationConfig } from "./support/app.ts";

test("Rslib cleans exposed requests without splitting their query tail", (t) => {
  const request = `./view.ts?raw${"?next".repeat(512)}`;
  const aliases = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`./${i}`, request]));
  const sharedImports = [request, "./view.ts??exclude-mf-dts"];
  const some = sharedImports.some.bind(sharedImports);
  let importScans = 0;
  sharedImports.some = (predicate, thisArg) => {
    importScans++;
    return some(predicate, thisArg);
  };
  const first = { import: sharedImports };
  const second = { import: sharedImports };
  const split = String.prototype.split;
  let largestSplit = 0;
  t.mock.method(
    String.prototype,
    "split",
    function (this: string, separator: string, limit?: number) {
      const segments: string[] = Reflect.apply(split, this, [separator, limit]);
      if (this === request && separator === "?")
        largestSplit = Math.max(largestSplit, segments.length);
      return segments;
    },
  );

  const cleaned = rslibDtsExposes({
    ...aliases,
    emptyQuery: "./view.ts??exclude-mf-dts",
    laterFlag: "./view.ts?raw?exclude-mf-dts",
    bare: "./empty.ts?",
    excluded: "./ignore.ts?exclude-mf-dts?raw",
    excludedObject: { import: ["./fallback.ts", "./ignore.ts?exclude-mf-dts=true"] },
    first,
    second,
  });
  assert.deepEqual(cleaned, {
    ...Object.fromEntries(Object.keys(aliases).map((alias) => [alias, "./view.ts"])),
    emptyQuery: "./view.ts",
    laterFlag: "./view.ts",
    bare: "./empty.ts",
    first,
    second,
  });
  assert.ok(largestSplit <= 2);
  assert.equal(importScans, 1);
});

test("Rslib discovery keeps the app and avoids searching an oversized evaluated expose", (t) => {
  let suffix = JSON.stringify("x".repeat(24));
  for (let i = 0; i < 12; i++) suffix = `twice(${suffix})`;
  const indexOf = String.prototype.indexOf;
  let oversizedSearches = 0;
  t.mock.method(
    String.prototype,
    "indexOf",
    function (this: string, search: string, position?: number) {
      if (search === "?" && this.length > 64 * 1024) oversizedSearches++;
      return indexOf.call(this, search, position);
    },
  );
  const app = discoverSource(
    `const twice = (text) => text + text;
    export default { lib: [{ format: 'mf', plugins: [pluginModuleFederation({
      name: 'widget', dts: false, exposes: { './view': './view.ts?' + ${suffix} },
    })] }] };`,
    path.resolve("rslib.config.ts"),
    {},
  );
  assert.equal(app?.name, "widget");
  assert.equal(app.generateTypes, false);
  assert.equal(oversizedSearches, 0);
});

test("Rslib charges original expose requests across aliases and import arrays", () => {
  const request = `./view.ts?${"x".repeat(32 * 1024)}`;
  const shared = { import: [request, request] };
  assert.deepEqual(rslibDtsExposes({ direct: request, shared }), {
    direct: "./view.ts",
    shared,
  });
  assert.equal(
    rslibDtsExposes({ direct: request, shared: { import: Array(32).fill(request) } }),
    UNKNOWN,
  );
});

test("Vite and Rslib bound computed config locations before normalizing them", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-config-location-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let expression = JSON.stringify("x".repeat(24));
  for (let i = 0; i < 12; i++) expression = `twice(${expression})`;
  const helper = "const twice = (value) => value + value;";
  const vite = discoverSource(
    `${helper} export default {base: '/assets?' + ${expression},
       plugins: [pluginModuleFederation({name:'widget'})]};`,
    path.join(root, "vite.config.ts"),
    {},
  );
  assert.equal(vite?.manifestPath, "/mf-manifest.json");

  fs.mkdirSync(path.join(root, "project"));
  const writeRslib = (value: string) =>
    fs.writeFileSync(
      path.join(root, "rslib.config.ts"),
      `${helper} export default {root: ${value}, lib: [{format:'mf',
        plugins: [pluginModuleFederation({name:'widget'})]}]};`,
    );
  writeRslib("'project'");
  assert.equal(readAppFolder(root, "development")?.folder, path.join(root, "project"));
  writeRslib(expression);
  const resolve = t.mock.method(path, "resolve");
  assert.equal(readAppFolder(root, "development"), null);
  assert.ok(
    resolve.mock.calls.every(({ arguments: args }) => args.every((arg) => arg.length < 98_304)),
  );
});

test("Rslib caps derived strings, remote addresses, and dev manifest prefixes independently", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-rslib-string-limits-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, ".env"),
    `CHUNK=${"x".repeat(64)}\nREMOTE=https://example.test\nASSETS=/assets\n`,
  );
  const twice = (count: number, expression: string) =>
    "twice(".repeat(count) + expression + ")".repeat(count);
  const config = path.join(root, "rslib.config.ts");
  const writeConfig = (assets: string) =>
    fs.writeFileSync(
      config,
      `
    const twice = (v) => v + v;
    const wide = ${twice(10, "process.env.CHUNK")};
    const excessive = ${twice(14, "process.env.CHUNK")};
    export default {
      dev: { assetPrefix: ${assets} },
      lib: [{ format: 'mf', plugins: [pluginModuleFederation({ name: 'library',
        remotes: {
          oversized: 'oversized@https://example.test/' + wide,
          amplified: 'amplified@https://example.test/' + excessive,
          valid: \`host@\${process.env.REMOTE}/mf-manifest.json\`
        }
      })] }],
    };
  `,
    );
  const messages: string[] = [];
  const log = createLogger({
    enabled: () => true,
    write: (_level, message) => messages.push(message),
  }).operation("manual");
  writeConfig("'/' + wide");
  const guarded = readAppFolder(root, "development", undefined, undefined, log);
  assert.deepEqual(
    guarded?.remotes.map(({ name, url }) => [name, url]),
    [
      ["oversized", null],
      ["amplified", null],
      ["host", "https://example.test/mf-manifest.json"],
    ],
  );
  assert.equal(guarded?.devManifestPath, undefined);
  assert.ok(messages.some((message) => message.includes("reason=string-evaluation-budget")));
  writeConfig("process.env.ASSETS");
  assert.equal(readAppFolder(root, "development")?.devManifestPath, "/assets/mf-manifest.json");
});

test("Discover reports distinct Rslib profiles targeting the same project from separate packages", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-rslib-profile-claim-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const launcher = path.join(root, "launcher");
  const project = path.join(root, "project");
  fs.mkdirSync(launcher);
  fs.mkdirSync(project);
  const launch = (dev: string) =>
    fs.writeFileSync(path.join(launcher, "package.json"), JSON.stringify({ scripts: { dev } }));
  const config = (port: number) => `export default {
    server: { port: ${port} },
    lib: [{ format: 'mf', plugins: [pluginModuleFederation({ name: 'library' })] }],
  };`;
  fs.writeFileSync(path.join(project, "package.json"), "{}");
  fs.writeFileSync(path.join(project, "rslib.config.ts"), config(4810));
  fs.writeFileSync(path.join(launcher, "custom.ts"), config(4811));
  launch("rslib mf-dev --root ../project --config ../launcher/custom.ts");
  assert.throws(() => scanWorkspace(root), /duplicate federation name: library/);
  launch("rslib mf-dev --root ../project");
  const apps = scanWorkspace(root);
  assert.deepEqual(Object.keys(apps), ["library"]);
  assert.equal(apps.library.configFile, path.join(project, "rslib.config.ts"));
  assert.equal(apps.library.port, 4810);
  assert.equal(apps.library.launchFolder, undefined);
});

test("Rslib caps repeated remote addresses before the app is sent to the host", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-rslib-remote-total-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const url = "https://example.test/mf-manifest.json?" + "x".repeat(31_800);
  fs.writeFileSync(path.join(root, ".env"), `SHARED=${url}\n`);
  const aliases = Array.from({ length: 300 }, (_, index) => `r${index}: shared`).join(", ");
  fs.writeFileSync(
    path.join(root, "rslib.config.ts"),
    `
    const shared = process.env.SHARED;
    export default { lib: [{ format: 'mf', plugins: [pluginModuleFederation({
      name: 'library', remotes: { ${aliases}, valid: 'https://example.test/mf-manifest.json' }
    })] }] };
  `,
  );
  const app = readAppFolder(root, "development");
  assert.ok(app);
  assert.equal(app.remotes.length, 301);
  assert.equal(app.remotes[0].url, url);
  assert.equal(app.remotes.at(-1)?.url, "https://example.test/mf-manifest.json");
  assert.ok(app.remotes.some(({ url }) => url === null));
  assert.ok(serialize({ apps: [app] }).byteLength < 2 * 1024 * 1024);
});

test("Rslib launcher migration preserves settings when package scripts cannot be read safely", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-launch-metadata-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(
    path.join(root, "package.json"),
    '{"scripts":{"dev":"rslib mf-dev --root project"}}',
  );
  fs.writeFileSync(
    path.join(project, "rslib.config.ts"),
    `export default {lib: [{format:'mf', plugins:[pluginModuleFederation({name:'widget'})]}]};`,
  );
  const app = readAppFolder(root, "development");
  assert.ok(app);
  const previous = () =>
    previousRslibAppLocation(
      [{ name: "root", path: root }],
      { path: "project" },
      app,
      root,
      "development",
      "dev",
    );
  assert.equal(previous(), project);
  const metadata = path.join(project, "package.json");
  fs.writeFileSync(path.join(project, "other.json"), "{}");
  fs.symlinkSync("other.json", metadata);
  const read = t.mock.method(fs, "readFileSync");
  assert.equal(previous(), undefined);
  fs.unlinkSync(metadata);
  fs.writeFileSync(metadata, `{ }${" ".repeat(512 * 1024)}`);
  assert.equal(previous(), undefined);
  assert.ok(read.mock.calls.every(({ arguments: [file] }) => file !== metadata));
});

test("Rslib launcher switches cannot supply another project's dotenv to remote links", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-env-package-boundary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "app");
  const sibling = path.join(root, "sibling");
  fs.mkdirSync(app);
  fs.mkdirSync(sibling);
  const pkg = path.join(sibling, "package.json");
  fs.writeFileSync(pkg, "{}");
  fs.writeFileSync(path.join(sibling, ".env.local"), "FIXTURE_PORT=8912\n");
  fs.symlinkSync("../sibling", path.join(app, "alias"), "dir");
  fs.writeFileSync(
    path.join(app, "rslib.config.ts"),
    `export default {lib: [{format:'mf', plugins:[pluginModuleFederation({name:'widget',
      remotes:{catalog:\`catalog@http://localhost:\${process.env.FIXTURE_PORT}/mf-manifest.json\`}})]}]};`,
  );
  const load = () =>
    loadKnownApps([{ name: "root", path: root }], { widget: { path: "app" } }, "development")[0];
  const launch = (dev: string) =>
    fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ scripts: { dev } }));
  for (const dir of ["../sibling", "alias"]) {
    launch(`rslib mf-dev --env-dir ${dir}`);
    assert.equal(load()?.remotes[0]?.url, null);
  }
  launch("rslib mf-dev --root ../sibling --config ../app/rslib.config.ts");
  assert.equal(load()?.folder, sibling);
  assert.equal(load()?.remotes[0]?.url, null);
  fs.unlinkSync(pkg);
  const sharedRoot = load();
  assert.equal(sharedRoot?.folder, sibling);
  assert.equal(sharedRoot.remotes[0]?.url, null);
});

test("Rslib keeps canonically distinct packages separate when Windows path comparison folds case", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-package-case-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const launcher = path.join(root, "DesignSystem");
  fs.mkdirSync(launcher);
  const siblingName = fs.existsSync(path.join(root, "designsystem"))
    ? "design-system"
    : "designsystem";
  const sibling = path.join(root, siblingName);
  fs.mkdirSync(sibling);
  fs.writeFileSync(
    path.join(launcher, "package.json"),
    JSON.stringify({ scripts: { dev: `rslib mf-dev --root ../${siblingName}` } }),
  );
  fs.writeFileSync(path.join(sibling, "package.json"), "{}");
  fs.writeFileSync(path.join(sibling, ".env.local"), "FIXTURE_PORT=8912\n");
  fs.writeFileSync(
    path.join(sibling, "rslib.config.ts"),
    `import { readFileSync } from 'node:fs';
     import { join } from 'node:path';
     import { parse } from 'dotenv';
     const local = parse(readFileSync(join(__dirname, '.env.local'), 'utf8'));
     export default {lib: [{format:'mf', plugins:[pluginModuleFederation({name:'widget',
       remotes: {
         ambient: \`ambient@http://localhost:\${process.env.FIXTURE_PORT}/mf-manifest.json\`,
         explicit: \`explicit@http://localhost:\${local.FIXTURE_PORT}/mf-manifest.json\`
       }})]}]};`,
  );

  const launcherPaths = [launcher, fs.realpathSync.native(launcher)];
  const siblingPaths = [sibling, fs.realpathSync.native(sibling)];
  const windowsLauncher = "C:/workspace/DesignSystem";
  const windowsSibling = "C:/workspace/designsystem";
  assert.equal(path.win32.relative(windowsLauncher, windowsSibling), "");
  const relative = path.relative;
  t.mock.method(path, "relative", (from: string, to: string) => {
    if (launcherPaths.includes(from)) {
      const base = siblingPaths.find(
        (folder) => to === folder || to.startsWith(`${folder}${path.sep}`),
      );
      if (base) {
        const suffix = to.slice(base.length).split(path.sep).join("/");
        return path.win32
          .relative(windowsLauncher, windowsSibling + suffix)
          .split("\\")
          .join(path.sep);
      }
    }
    return relative(from, to);
  });

  const [app] = loadKnownApps(
    [{ name: "root", path: root }],
    { widget: { path: "DesignSystem" } },
    "development",
  );
  assert.equal(app?.folder, sibling);
  assert.deepEqual(
    app.remotes.map(({ url }) => url),
    [null, null],
  );
  assert.equal(app.launchEnvironment?.allowLocalEnv, false);
  const direct = readAppFolder(sibling, "development");
  assert.deepEqual(
    direct?.remotes.map(({ url }) => url),
    ["http://localhost:8912/mf-manifest.json", "http://localhost:8912/mf-manifest.json"],
  );
  const discovered = scanWorkspace(root).widget;
  assert.equal(discovered?.folder, sibling);
  assert.equal(discovered.launchFolder, undefined);
  assert.deepEqual(
    loadKnownApps(
      [{ name: "root", path: launcher }],
      { widget: { path: `../${siblingName}` } },
      "development",
    ),
    [],
  );

  fs.writeFileSync(path.join(launcher, "package.json"), '{"scripts":{"dev":"rslib mf-dev"}}');
  fs.writeFileSync(path.join(launcher, "local.json"), '{"port":8911}');
  fs.writeFileSync(path.join(sibling, "foreign.json"), '{"port":8912}');
  fs.writeFileSync(
    path.join(launcher, "rslib.config.ts"),
    `import local from './local.json';
     import foreign from '../${siblingName}/foreign.json';
     export default {lib: [{format:'mf', plugins:[pluginModuleFederation({name:'widget',
       remotes: {
         local: \`local@http://localhost:\${local.port}/mf-manifest.json\`,
         foreign: \`foreign@http://localhost:\${foreign.port}/mf-manifest.json\`
       }})]}]};`,
  );
  assert.deepEqual(
    readAppFolder(launcher, "development")?.remotes.map(({ url }) => url),
    ["http://localhost:8911/mf-manifest.json", null],
  );
});

test("Rslib drops dotenv when the approved env directory changes before reading", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-env-directory-change-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "app");
  const env = path.join(app, "env");
  const sibling = path.join(root, "sibling");
  fs.mkdirSync(env, { recursive: true });
  fs.mkdirSync(sibling);
  fs.writeFileSync(
    path.join(app, "package.json"),
    '{"scripts":{"dev":"rslib mf-dev --env-dir env"}}',
  );
  fs.writeFileSync(path.join(sibling, "package.json"), "{}");
  fs.writeFileSync(path.join(sibling, ".env.local"), "FIXTURE_PORT=8912\n");
  fs.writeFileSync(path.join(env, ".env.local"), "FIXTURE_PORT=8911\n");
  fs.writeFileSync(
    path.join(app, "rslib.config.ts"),
    `export default {lib: [{format:'mf', plugins:[pluginModuleFederation({name:'widget',
      remotes:{catalog:\`catalog@http://localhost:\${process.env.FIXTURE_PORT}/mf-manifest.json\`}})]}]};`,
  );
  const load = () =>
    loadKnownApps([{ name: "root", path: root }], { widget: { path: "app" } }, "development")[0];
  assert.equal(load()?.remotes[0]?.url, "http://localhost:8911/mf-manifest.json");

  const envManifest = path.join(fs.realpathSync(env), "package.json");
  const oldEnv = path.join(app, "old-env");
  const lstat = fs.lstatSync;
  const envFile = path.join(env, ".env.local");
  for (const change of ["symlink", "directory", "package"]) {
    let changed = false;
    const mock = t.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
      const result = Reflect.apply(lstat, fs, args);
      if (!changed && args[0] === envManifest) {
        changed = true;
        if (change === "package") {
          fs.writeFileSync(envManifest, "{}");
          fs.writeFileSync(envFile, "FIXTURE_PORT=8912\n");
        } else {
          fs.renameSync(env, oldEnv);
          if (change === "symlink") fs.symlinkSync(sibling, env, "dir");
          else fs.renameSync(sibling, env);
        }
      }
      return result;
    });
    assert.equal(load()?.remotes[0]?.url, null);
    assert.equal(changed, true);
    mock.mock.restore();
    if (change === "package") {
      fs.unlinkSync(envManifest);
    } else {
      if (change === "symlink") fs.unlinkSync(env);
      else fs.renameSync(env, sibling);
      fs.renameSync(oldEnv, env);
    }
  }
});

test(
  "a transient parent substitution cannot redirect a scoped dotenv read",
  {
    skip: process.platform === "win32",
  },
  (t) => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mf-dotenv-open-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dir = path.join(root, "env");
    const other = path.join(root, "other");
    const saved = path.join(root, "original-env");
    const file = path.join(dir, ".env.local");
    fs.mkdirSync(dir);
    fs.mkdirSync(other);
    fs.writeFileSync(file, "VALUE=approved\n");
    fs.writeFileSync(path.join(other, ".env.local"), "VALUE=other\n");
    const expectedDirectory = readConfigDirectory(dir);
    assert.ok(expectedDirectory);
    const read = () => readConfigInput(file, 64, { expectedDirectory });
    assert.equal(read(), "VALUE=approved\n");

    const lstat = fs.lstatSync;
    let leafChecks = 0;
    const hook = t.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
      if (args[0] !== file) return Reflect.apply(lstat, fs, args);
      leafChecks++;
      if (leafChecks === 1) {
        fs.renameSync(dir, saved);
        fs.symlinkSync(other, dir, "dir");
      }
      const result = Reflect.apply(lstat, fs, args);
      if (leafChecks === 2) {
        fs.unlinkSync(dir);
        fs.renameSync(saved, dir);
      }
      return result;
    });
    assert.equal(read(), null);
    assert.ok(leafChecks > 0);
    hook.mock.restore();
    if (fs.existsSync(saved)) {
      fs.unlinkSync(dir);
      fs.renameSync(saved, dir);
    }
    assert.equal(read(), "VALUE=approved\n");
  },
);

test("explicit dotenv reads reuse results and bound distinct file lookups", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-dotenv-lookup-budget-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const program = parseProgram("export default {};", path.join(root, "rslib.config.ts"));
  assert.ok(program);
  const imports = new ConfigImports(program);
  const file = path.join(root, ".env.local");
  const absent = path.join(root, ".env.absent");
  fs.writeFileSync(file, "VALUE=first\n");
  assert.equal(imports.readEnvText(file), "VALUE=first\n");
  assert.equal(imports.readEnvText(absent), null);
  fs.writeFileSync(file, "VALUE=second\n");
  fs.writeFileSync(absent, "VALUE=created\n");
  assert.equal(imports.readEnvText(file), "VALUE=first\n");
  assert.equal(imports.readEnvText(absent), null);

  for (let index = 0; index < 12; index++) {
    const name = path.join(root, `.env.profile-${index}`);
    fs.writeFileSync(name, "VALUE=profile\n");
    assert.equal(imports.readEnvText(name), index < 6 ? "VALUE=profile\n" : null);
  }
});

test("an unrelated Rslib reference cannot hide a configured app in another root", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-owned-options-only-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const claimant = path.join(root, "claimant");
  const project = path.join(root, "project");
  fs.mkdirSync(claimant);
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  const standalone = path.join(project, "module-federation.config.ts");
  fs.writeFileSync(
    standalone,
    "export const other = {name:'different'}; export default {name:'widget'};",
  );
  const roots = [
    { name: "claimant", path: claimant },
    { name: "project", path: project },
  ];
  const load = () =>
    loadKnownApps(roots, { widget: { path: ".", workspaceFolder: "project" } }, "development");
  for (const config of [
    `import '../project/module-federation.config'; export default {};`,
    `import mf from '../project/module-federation.config';
     export default { server: { port: mf.port }, lib: [{format:'esm'}] };`,
    `import mf from '../project/module-federation.config';
     export default { lib: [{format:'mf', plugins:[pluginModuleFederation({...mf, name:'different'})]}] };`,
    `import { other } from '../project/module-federation.config';
     export default { lib: [{format:'mf', plugins:[pluginModuleFederation(other)]}] };`,
  ]) {
    fs.writeFileSync(path.join(claimant, "rslib.config.ts"), config);
    assert.deepEqual(
      load().map(({ name }) => name),
      ["widget"],
    );
  }
  assert.deepEqual(Object.keys(scanWorkspace(root)).sort(), ["different", "widget"]);
  fs.writeFileSync(
    standalone,
    "export const other = {name:'widget'}; export default {name:'widget'};",
  );
  assert.equal(load()[0]?.folder, project);
  assert.throws(() => scanWorkspace(root), /duplicate federation name: widget/);

  fs.writeFileSync(path.join(project, "runtime-plugin.cjs"), "module.exports = () => ({});");
  for (const primary of [
    "other",
    "true ? other : null",
    "createModuleFederationConfig(other)",
    "{...other, dts:false}",
    "() => other",
  ]) {
    fs.writeFileSync(
      standalone,
      `import { createModuleFederationConfig } from '@module-federation/enhanced';
       export const other = {name:'widget', dts:process.env.NODE_ENV === 'development',
         runtimePlugins:[require.resolve('./runtime-plugin.cjs')]};
       export default ${primary};`,
    );
    assert.equal(scanWorkspace(root).widget.folder, claimant, primary);
    assert.deepEqual(load(), [], primary);
  }

  for (const [source, binding] of [
    [`export default { name:'widget', plugins:[pluginModuleFederation({name:'widget'})] };`, "mf"],
    [
      `export const other = {name:'widget'};
       export default (options={}) => options.command === 'mf-dev' ? other : {name:'widget'};`,
      "{other as mf}",
    ],
    [
      `const make = (port) => ({name:'widget', remotes:{
        catalog: 'catalog@http://localhost:' + port + '/mf-manifest.json',
       }});
       export const other = make(8912);
       export default make(8911);`,
      "{other as mf}",
    ],
  ]) {
    fs.writeFileSync(standalone, source);
    fs.writeFileSync(
      path.join(claimant, "rslib.config.ts"),
      `import ${binding} from '../project/module-federation.config';
       export default { lib: [{format:'mf', plugins:[pluginModuleFederation(mf)]}] };`,
    );
    assert.equal(load()[0]?.folder, project);
    assert.throws(() => scanWorkspace(root), /duplicate federation name: widget/);
    const owner = readAppFolder(claimant, "development");
    assert.ok(owner);
    assert.equal(
      previousRslibAppLocation(
        roots,
        { path: ".", workspaceFolder: "project" },
        owner,
        claimant,
        "development",
        "dev",
      ),
      undefined,
    );
  }

  fs.unlinkSync(path.join(claimant, "rslib.config.ts"));
  fs.writeFileSync(standalone, "export default {name:'widget'};");
  fs.writeFileSync(
    path.join(claimant, "package.json"),
    '{"scripts":{"dev":"rslib mf-dev --root ../project --config module-federation.config.ts"}}',
  );
  assert.equal(scanWorkspace(root).widget.folder, project);

  fs.writeFileSync(
    path.join(claimant, "package.json"),
    '{"scripts":{"dev":"MF_NAME=launcher rslib mf-dev --root ../project"}}',
  );
  fs.writeFileSync(
    path.join(project, "rslib.config.ts"),
    `export default { lib: [{format:'mf', plugins:[pluginModuleFederation({
      name:process.env.MF_NAME ?? 'widget',
    })]}] };`,
  );
  fs.unlinkSync(standalone);
  const apps = scanWorkspace(root);
  assert.deepEqual(Object.keys(apps).sort(), ["launcher", "widget"]);
  assert.equal(apps.launcher.launchFolder, claimant);
  assert.equal(apps.widget.launchFolder, undefined);
});

test("discovery skips an oversized imported federation config in both roles", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-oversized-helper-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const library = path.join(root, "library");
  fs.mkdirSync(library);
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(
    path.join(library, "rslib.config.ts"),
    `import options from '../module-federation.config';
    export default {lib: [{format:'mf', plugins: [pluginModuleFederation(options)]}]};`,
  );
  const helper = path.join(root, "module-federation.config.ts");
  const options = "export default {name:'library'};";
  fs.writeFileSync(helper, `${options}/*${"x".repeat(CONFIG_INPUT_LIMIT)}*/`);
  assert.deepEqual(scanWorkspace(root), {});
  assert.equal(readAppFolder(library, "development"), null);

  fs.writeFileSync(helper, options);
  const apps = scanWorkspace(root);
  assert.deepEqual(Object.keys(apps), ["library"]);
  assert.equal(apps.library.folder, library);
});

test("static config imports share a cumulative source byte limit", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-helper-budget-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(
    path.join(root, "rslib.config.ts"),
    `import a from './a'; import b from './b'; import c from './c';
    export default {lib: [{format: 'mf', plugins: [pluginModuleFederation({name: a + b + c})]}]};`,
  );
  const padding = "é".repeat((3 * CONFIG_INPUT_LIMIT) / 8);
  const writeHelper = (file: string, value: string, comment = padding) =>
    fs.writeFileSync(path.join(root, file), `export default '${value}';/*${comment}*/`);
  writeHelper("a.ts", "data");
  writeHelper("b.ts", "-kit");
  writeHelper("c.ts", "-one");
  assert.equal(readAppFolder(root, "development"), null);

  writeHelper("c.ts", "-one", "");
  assert.equal(readAppFolder(root, "development")?.name, "data-kit-one");
});

test("a helper that grows during a read still counts toward the limit", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-helper-growth-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(
    path.join(root, "rslib.config.ts"),
    `import first from './first'; import second from './second'; import bridge from './bridge';
    export default { values: [first, second, bridge] };`,
  );
  const padding = `/*${"x".repeat((3 * CONFIG_INPUT_LIMIT) / 4)}*/`;
  const growing = new Map<number, string>();
  for (const name of ["first", "second"]) {
    const file = path.join(root, `${name}.ts`);
    fs.writeFileSync(file, padding);
    growing.set(fs.statSync(file).ino, file);
  }
  const nested = path.join(root, "nested", "module-federation.config.ts");
  fs.mkdirSync(path.dirname(nested));
  fs.writeFileSync(nested, "export default {};");
  fs.writeFileSync(
    path.join(root, "bridge.ts"),
    `export { default } from './nested/module-federation.config';${padding}`,
  );
  const fstat = fs.fstatSync;
  t.mock.method(fs, "fstatSync", (fd: number) => {
    const stat = fstat(fd);
    const file = growing.get(stat.ino);
    if (file) {
      growing.delete(stat.ino);
      fs.appendFileSync(file, " ");
    }
    return stat;
  });

  const dependencies = new Set<string>();
  assert.equal(readAppFolder(root, "development", undefined, dependencies), null);
  assert.equal(growing.size, 0);
  assert.equal(dependencies.has(nested), false);
});

test("discovery skips a Rslib environment over its expansion limit and recovers on edit", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-env-budget-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const independent = path.join(root, "independent");
  fs.mkdirSync(independent);
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(
    path.join(root, "rslib.config.ts"),
    `import options from './module-federation.config';
    export default {lib: [{format:'mf', plugins: [pluginModuleFederation(options)]}]};`,
  );
  fs.writeFileSync(
    path.join(root, "module-federation.config.ts"),
    "export default {name:'library'};",
  );
  fs.writeFileSync(
    path.join(independent, "module-federation.config.ts"),
    "export default {name:'independent'};",
  );
  const envFile = path.join(root, ".env");
  const writeEnv = (value: string) =>
    fs.writeFileSync(
      envFile,
      `SHARED=${value}\n${Array.from({ length: 33 }, (_, i) => `LABEL_${i}=\${SHARED}-${i}`).join("\n")}`,
    );
  writeEnv("x".repeat(32 * 1024));
  const dependencies = new Set<string>();
  assert.throws(() => readRslibEnv(root, "development"), RslibEnvLimitError);
  assert.deepEqual(Object.keys(scanWorkspace(root, { dependencies })), ["independent"]);
  assert.ok(dependencies.has(envFile));

  writeEnv("label");
  const apps = scanWorkspace(root);
  assert.equal(apps.library.launchEnvironment?.env.LABEL_32, "label-32");
  assert.equal(apps.independent.name, "independent");
});

test("Rslib also bounds repeated substitutions whose final output stays small", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-env-work-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const envFile = path.join(root, ".env");
  const value = "x".repeat(24 * 1024);
  const writeEnv = (count: number) =>
    fs.writeFileSync(envFile, `VALUE=${value}${"${MISSING}".repeat(count)}`);
  writeEnv(512);
  assert.throws(() => readRslibEnv(root, "development"), RslibEnvLimitError);
  writeEnv(2);
  assert.equal(readRslibEnv(root, "development").VALUE, value);
});

test("a nested Rslib config owns its federation helper in both profiles", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-rslib-owned-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configs = path.join(root, "configs");
  const shared = path.join(root, "shared");
  fs.mkdirSync(configs);
  fs.mkdirSync(shared);
  const launch = (env: string) =>
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: { dev: `cross-env NODE_ENV=${env} rslib mf-dev -c configs/rslib.config.ts` },
      }),
    );
  fs.writeFileSync(
    path.join(configs, "module-federation.config.ts"),
    `export { default } from '../shared/module-federation.config';`,
  );
  fs.writeFileSync(
    path.join(shared, "module-federation.config.ts"),
    `export default { name: 'library', dts: true };`,
  );
  fs.writeFileSync(
    path.join(configs, "mf-profile.ts"),
    `
    import mf from './module-federation.config';
    export default { format: 'mf', plugins: [pluginModuleFederation(mf)] };`,
  );
  fs.writeFileSync(
    path.join(configs, "rslib.config.ts"),
    `
    import profile from './mf-profile';
    export default { lib: process.env.NODE_ENV === 'development' ? [profile] : [{ format: 'esm' }] };`,
  );
  launch("production");
  assert.deepEqual(scanWorkspace(root), {});
  launch("development");
  const apps = scanWorkspace(root);
  assert.deepEqual(Object.keys(apps), ["library"]);
  assert.equal(apps.library.folder, root);
});

test("Rslib leaves an independent standalone federation config available to Rspack", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-rslib-mixed-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), '{"scripts":{"dev":"rslib mf-dev"}}');
  fs.writeFileSync(
    path.join(root, "rslib.config.ts"),
    `export default { lib: [{ format: 'esm' }] };`,
  );
  fs.writeFileSync(
    path.join(root, "rspack.config.ts"),
    `export default { devServer: { port: 4100 } };`,
  );
  fs.writeFileSync(
    path.join(root, "module-federation.config.ts"),
    `export default { name: 'workspace', dts: true };`,
  );
  assert.equal(scanWorkspace(root).workspace?.port, 4100);
});

test("Rslib claims a federation helper even when its sibling folder is scanned first", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-rslib-sibling-helper-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shared = path.join(root, "shared");
  const library = path.join(root, "z-library");
  fs.mkdirSync(shared);
  fs.mkdirSync(library);
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(
    path.join(shared, "module-federation.config.ts"),
    `export default { name: 'library' };`,
  );
  fs.writeFileSync(
    path.join(library, "rslib.config.ts"),
    `
    import mf from '../shared/module-federation.config';
    export default { lib: [{ format: 'mf', plugins: [pluginModuleFederation(mf)] }] };`,
  );
  const apps = scanWorkspace(root);
  assert.deepEqual(Object.keys(apps), ["library"]);
  assert.equal(apps.library.folder, library);

  if (fs.existsSync(path.join(root, "SHARED"))) {
    const file = path.join(library, "rslib.config.ts");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("../shared/", "../SHARED/"));
    const aliased = scanWorkspace(root);
    assert.deepEqual(Object.keys(aliased), ["library"]);
    assert.equal(aliased.library.folder, library);
    const tracked = aliased.library.configInputs?.find(
      ({ file }) => file === path.join(root, "SHARED", "module-federation.config.ts"),
    );
    assert.ok(tracked && configInputFingerprint(tracked));
  }
});

test("Rslib claims the canonical federation helper behind an import symlink", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-rslib-helper-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = path.join(root, "library");
  const helper = path.join(root, "a-shared", "module-federation.config.ts");
  fs.mkdirSync(owner);
  fs.mkdirSync(path.dirname(helper));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(helper, `export default { name: 'library' };`);
  fs.symlinkSync("../a-shared/module-federation.config.ts", path.join(owner, "alias.ts"));
  fs.writeFileSync(
    path.join(owner, "rslib.config.ts"),
    `
    import mf from './alias';
    export default { lib: [{ format: 'mf', plugins: [pluginModuleFederation(mf)] }] };
  `,
  );
  const dependencies = new Set<string>();
  const found = scanWorkspace(root, { dependencies });
  assert.deepEqual(Object.keys(found), ["library"]);
  assert.equal(found.library.folder, owner);
  assert.deepEqual(found.library.federationHelpers, [fs.realpathSync(helper)]);
  assert.ok(dependencies.has(path.join(owner, "alias.ts")));
  assert.ok(found.library.ownershipSources?.has(fs.realpathSync(helper)));
  assert.deepEqual(
    loadKnownApps([{ name: "root", path: root }], { library: { path: "a-shared" } }, "development"),
    [],
  );
});

test("Rslib recognizes global flags before mf-dev and keeps positional option values", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-rslib-launch-order-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = path.join(root, "package.json");
  fs.writeFileSync(
    path.join(root, "rslib.config.ts"),
    `
    export default { lib: [{ format: 'mf', plugins: [pluginModuleFederation({ name: 'fallback' })] }] };
  `,
  );
  fs.writeFileSync(
    path.join(root, "custom.ts"),
    `
    export default { lib: [{ format: 'mf', plugins: [pluginModuleFederation({ name: 'custom' })] }] };
  `,
  );
  for (const dev of [
    "rslib --config custom.ts mf-dev",
    "rslib --env-mode development -c=custom.ts mf-dev",
  ]) {
    fs.writeFileSync(pkg, JSON.stringify({ scripts: { dev } }));
    assert.deepEqual(Object.keys(scanWorkspace(root)), ["custom"]);
    assert.equal(readAppFolder(root, "development")?.name, "custom");
  }
  fs.writeFileSync(
    pkg,
    JSON.stringify({ scripts: { dev: "rslib --env-mode mf-dev build -c custom.ts" } }),
  );
  assert.deepEqual(Object.keys(scanWorkspace(root)), ["fallback"]);
});

test("Rslib --root selects the nested config and env while retaining the script folder", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-rslib-project-root-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const env = path.join(project, "env");
  fs.mkdirSync(env, { recursive: true });
  const writeScript = (dev: string) =>
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { dev } }));
  fs.writeFileSync(
    path.join(root, "rslib.config.ts"),
    "export default {lib:[{format:'mf',plugins:[pluginModuleFederation({name:'parent'})]}]};",
  );
  const config = `export default {
    root: 'unused', server: { port: process.env.PORT }, output: { distPath: 'artifacts' },
    lib: [{ format: 'mf', plugins: [pluginModuleFederation({ name: 'nested' })] }],
  };`;
  fs.writeFileSync(path.join(project, "rslib.config.ts"), config);
  fs.writeFileSync(path.join(project, "custom.ts"), config);
  fs.writeFileSync(path.join(root, "override.ts"), config);
  fs.writeFileSync(path.join(project, "tsconfig.json"), "{}");
  fs.writeFileSync(path.join(root, ".env.development"), "PORT=4910\n");
  fs.writeFileSync(path.join(project, ".env.development"), "PORT=4911\n");
  fs.writeFileSync(path.join(env, ".env.development"), "PORT=4912\n");
  const cache = createAppParseCache();
  const roots = [{ name: "root", path: root }];
  const load = () => loadKnownApps(roots, { nested: { path: "." } }, "development", [], cache)[0];
  for (const [dev, configFile, port] of [
    ["rslib --root project mf-dev", "rslib.config.ts", 4911],
    ["rslib mf-dev -r=project --config custom.ts --env-dir env", "custom.ts", 4912],
  ] as const) {
    writeScript(dev);
    const found = scanWorkspace(root);
    assert.deepEqual(Object.keys(found), ["nested"]);
    for (const app of [found.nested, load()]) {
      assert.equal(app?.folder, project);
      assert.equal(app.launchFolder, root);
      assert.equal(app.configFile, path.join(project, configFile));
      assert.equal(app.port, port);
      assert.equal(app.generatedZipPath, path.join(project, "artifacts/@mf-types.zip"));
    }
  }
  fs.writeFileSync(path.join(env, ".env.development"), "PORT=4913\n");
  assert.equal(load()?.port, 4913);
  const [override] = loadKnownApps(
    roots,
    { nested: { path: ".", configFile: "project/rslib.config.ts" } },
    "development",
    [],
    cache,
  );
  assert.equal(override?.folder, project);
  assert.equal(override.configFile, path.join(project, "rslib.config.ts"));
  assert.equal(override.port, 4913);
  const [outerOverride] = loadKnownApps(
    roots,
    { nested: { path: ".", configFile: "override.ts" } },
    "development",
    [],
    cache,
  );
  assert.equal(outerOverride?.folder, project);
  assert.equal(outerOverride.configFile, path.join(root, "override.ts"));
  assert.equal(outerOverride.port, 4913);
  assert.equal(outerOverride.generateTypes, true);
  fs.writeFileSync(path.join(project, "rslib.config.ts"), config.replace("root: 'unused', ", ""));
  assert.deepEqual(scanWorkspace(root, { ignorePaths: ["project"] }), {});
  fs.symlinkSync("project", path.join(root, "alias"), "dir");
  writeScript("rslib mf-dev --root alias");
  const aliased = scanWorkspace(root);
  assert.deepEqual(Object.keys(aliased), ["nested"]);
  assert.equal(aliased.nested.folder, project);
  assert.equal(aliased.nested.launchFolder, root);
  assert.deepEqual(scanWorkspace(root, { ignorePaths: ["project"] }), {});
  if (fs.existsSync(path.join(root, "PROJECT"))) {
    writeScript("rslib mf-dev --root PROJECT");
    const caseAlias = scanWorkspace(root);
    assert.deepEqual(Object.keys(caseAlias), ["nested"]);
    assert.equal(caseAlias.nested.folder, project);
    assert.equal(caseAlias.nested.launchFolder, root);
    assert.deepEqual(scanWorkspace(root, { ignorePaths: ["project"] }), {});
  }
  writeScript("rslib mf-dev --root project --config ../override.ts");
  const outsideProject = scanWorkspace(root).nested;
  assert.equal(outsideProject?.configFile, path.join(root, "override.ts"));
  assert.equal(outsideProject.folder, project);
  assert.equal(load()?.port, 4911);
  fs.writeFileSync(
    path.join(root, "vite.config.ts"),
    `export default { plugins: [pluginModuleFederation({ name: 'web' })] };`,
  );
  assert.deepEqual(Object.keys(scanWorkspace(root)), ["nested", "web"]);
  assert.deepEqual(
    loadKnownApps(
      roots,
      { nested: { path: "." }, web: { path: "." } },
      "development",
      [],
      cache,
    ).map(({ name }) => name),
    ["nested", "web"],
  );
  const broken = path.join(project, "broken.ts");
  fs.writeFileSync(broken, "export default {");
  for (const script of [
    "rslib mf-dev --root missing",
    "rslib mf-dev --root project --config missing.ts",
    "rslib mf-dev --root project --config broken.ts",
  ]) {
    writeScript(script);
    assert.equal(scanWorkspace(root).web?.configFile, path.join(root, "vite.config.ts"));
    assert.equal(
      loadKnownApps(roots, { web: { path: "." } }, "development", [], cache)[0]?.name,
      "web",
    );
  }
  fs.unlinkSync(path.join(root, "vite.config.ts"));
  writeScript("rslib mf-dev -r=project --config custom.ts --env-dir env");
  fs.writeFileSync(path.join(project, "package.json"), '{"scripts":{"dev":"vite"}}');
  fs.writeFileSync(
    path.join(project, "vite.config.ts"),
    `export default { plugins: [pluginModuleFederation({ name: 'web' })] };`,
  );
  assert.deepEqual(Object.keys(scanWorkspace(root)), ["nested", "web"]);
  fs.writeFileSync(
    path.join(project, "package.json"),
    '{"scripts":{"dev":"PORT=4914 rslib mf-dev"}}',
  );
  assert.throws(() => scanWorkspace(root), /duplicate federation name: nested/);
  fs.unlinkSync(path.join(project, "package.json"));
  fs.unlinkSync(path.join(project, "vite.config.ts"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mf-rslib-outside-root-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "rslib.config.ts"), config);
  fs.symlinkSync(outside, path.join(root, "outside"), "dir");
  writeScript("rslib mf-dev --root outside");
  assert.equal(load(), undefined);
  assert.deepEqual(Object.keys(scanWorkspace(root)), ["nested"]);
});

test("a federation helper owned by a later folder cannot supply settings to a same-name app", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-rslib-owned-merge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shared = path.join(root, "shared");
  const library = path.join(root, "z-library");
  fs.mkdirSync(shared);
  fs.mkdirSync(library);
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(
    path.join(shared, "module-federation.config.ts"),
    `export { default } from './options';`,
  );
  const options = path.join(shared, "options.ts");
  fs.writeFileSync(
    options,
    `export default { name: 'web', dts: true, remotes: { alpha: 'alpha@http://localhost:3001/mf-manifest.json' } };`,
  );
  const rspack = path.join(shared, "rspack.config.ts");
  fs.writeFileSync(
    rspack,
    `export default { plugins: [new ModuleFederationPlugin({ name: 'web', dts: false })] };`,
  );
  fs.writeFileSync(path.join(library, ".env"), "NODE_ENV=production\n");
  fs.writeFileSync(
    path.join(library, "rslib.config.ts"),
    developmentFederationConfig("../shared/module-federation.config"),
  );
  const apps = scanWorkspace(root);
  assert.deepEqual(Object.keys(apps), ["web"]);
  assert.equal(apps.web.configFile, rspack);
  assert.equal(apps.web.generateTypes, false);
  assert.deepEqual(apps.web.remotes, []);
  const roots = [{ name: "root", path: root }];
  const cache = createAppParseCache();
  const refresh = (ignorePaths: string[] = []) =>
    loadKnownApps(roots, { web: { path: "shared" } }, "development", ignorePaths, cache)[0];
  const initial = refresh();
  assert.equal(initial.configFile, rspack);
  assert.equal(initial.generateTypes, false);
  assert.deepEqual(initial.remotes, []);
  const config = path.join(library, "rslib.config.ts");
  assert.equal(savedFileKind(apps.web, config, "development"), "config");
  assert.equal(savedFileKind(refresh(), config, "development"), "config");
  assert.equal(refresh(["z-library"]).generateTypes, true);
  assert.equal(refresh().generateTypes, false);
  const rslibSource = fs.readFileSync(config, "utf8");
  fs.unlinkSync(config);
  assert.equal(refresh().generateTypes, true);
  fs.writeFileSync(config, rslibSource);
  assert.equal(refresh().generateTypes, false);
  fs.renameSync(library, path.join(root, "a-library"));
  assert.equal(scanWorkspace(root).web.configFile, rspack);
});

test("a saved standalone helper stays hidden unless explicitly selected", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-rslib-saved-helper-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const library = path.join(root, "library");
  const shared = path.join(root, "shared");
  fs.mkdirSync(library);
  fs.mkdirSync(shared);
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  const helper = "module-federation.config.ts";
  fs.writeFileSync(path.join(shared, helper), `export default { name: 'legacy', dts: true };`);
  fs.writeFileSync(path.join(library, ".env"), "NODE_ENV=production\n");
  fs.writeFileSync(
    path.join(library, "rslib.config.ts"),
    developmentFederationConfig("../shared/module-federation.config"),
  );
  const roots = [{ name: "root", path: root }];
  assert.deepEqual(scanWorkspace(root), {});
  assert.deepEqual(loadKnownApps(roots, { legacy: { path: "shared" } }, "development"), []);
  const [selected] = loadKnownApps(
    roots,
    { legacy: { path: "shared", configFile: helper } },
    "development",
  );
  assert.equal(selected?.configFile, path.join(shared, helper));
});

test("an ignored saved Rslib app still claims its standalone helper", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-rslib-ignored-owner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const library = path.join(root, "library");
  const shared = path.join(root, "shared");
  fs.mkdirSync(library);
  fs.mkdirSync(shared);
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(
    path.join(shared, "module-federation.config.ts"),
    `export default { name: 'foo' };`,
  );
  fs.writeFileSync(
    path.join(library, "rslib.config.ts"),
    `
    import mf from '../shared/module-federation.config';
    export default { lib: [{ format: 'mf', plugins: [pluginModuleFederation(mf)] }] };
  `,
  );
  const roots = [{ name: "root", path: root }];
  const cache = createAppParseCache();
  const legacy = { path: "shared" };
  const owner = { path: "library" };
  fs.symlinkSync("library", path.join(root, "alias"), "dir");
  const load = (withOwner: boolean) =>
    loadKnownApps(
      roots,
      withOwner ? { legacy, foo: owner } : { legacy },
      "development",
      ["library"],
      cache,
    ).map(({ folder }) => folder);
  assert.deepEqual(scanWorkspace(root, { ignorePaths: ["library"] }).foo?.folder, shared);
  assert.deepEqual(load(false), [shared]);
  assert.deepEqual(load(true), [library]);
  assert.deepEqual(load(false), [shared]);
  const aliased = loadKnownApps(
    roots,
    { legacy, foo: { path: "alias" } },
    "development",
    ["library"],
    cache,
  );
  assert.deepEqual(
    aliased.map(({ name, folder }) => [name, folder]),
    [["foo", path.join(root, "alias")]],
  );
});

test("configured Rslib script and file overrides claim their standalone helpers", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-rslib-configured-owner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const library = path.join(root, "library");
  const shared = path.join(library, "shared");
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(
    path.join(library, "package.json"),
    '{"scripts":{"serve":"rslib mf-dev -c custom.ts"}}',
  );
  fs.writeFileSync(
    path.join(shared, "module-federation.config.ts"),
    `export default { name: 'lib' };`,
  );
  fs.writeFileSync(
    path.join(library, "custom.ts"),
    `
    import { defineConfig } from '@rslib/core';
    import mf from './shared/module-federation.config';
    export default defineConfig({ lib: [{ format: 'mf', plugins: [pluginModuleFederation(mf)] }] });
  `,
  );
  const roots = [{ name: "root", path: root }];
  const cache = createAppParseCache();
  const legacy = { path: "library/shared" };
  const folders = (apps: Parameters<typeof loadKnownApps>[1]) =>
    loadKnownApps(roots, apps, "development", [], cache).map(({ folder }) => folder);
  assert.deepEqual(folders({ legacy }), [shared]);
  assert.deepEqual(folders({ legacy, lib: { path: "library", scripts: { start: "serve" } } }), [
    library,
  ]);
  assert.deepEqual(folders({ legacy, lib: { path: "library", configFile: "custom.ts" } }), [
    library,
  ]);
  assert.deepEqual(folders({ legacy }), [shared]);
  const other = path.join(root, "other-workspace");
  const otherLibrary = path.join(other, "library");
  fs.cpSync(library, otherLibrary, { recursive: true });
  fs.writeFileSync(
    path.join(otherLibrary, "shared", "module-federation.config.ts"),
    `export default { name: 'legacy' };`,
  );
  const apps = loadKnownApps(
    [{ name: "other", path: other }, ...roots],
    {
      legacy: { ...legacy, workspaceFolder: "other" },
      lib: { path: "library", scripts: { start: "serve" } },
    },
    "development",
    [],
    cache,
  );
  assert.deepEqual(
    apps.map(({ name, folder }) => [name, folder]),
    [
      ["legacy", path.join(otherLibrary, "shared")],
      ["lib", library],
    ],
  );
});

test("an ignored nested Rslib entry still owns its standalone helper", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-rslib-ignored-entry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = path.join(root, "owner");
  const configDir = path.join(owner, "configs");
  const shared = path.join(owner, "shared");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(shared);
  fs.writeFileSync(
    path.join(owner, "package.json"),
    '{"scripts":{"dev":"rslib mf-dev -c configs/custom.ts"}}',
  );
  fs.writeFileSync(
    path.join(configDir, "custom.ts"),
    `import mf from '../shared/module-federation.config';
    export default { lib: [{ format: 'mf', plugins: [pluginModuleFederation(mf)] }] };`,
  );
  fs.writeFileSync(
    path.join(shared, "module-federation.config.ts"),
    `export default { name: 'widget' };`,
  );
  const roots = [{ name: "root", path: root }];
  const apps = { widget: { path: "owner" }, legacy: { path: "owner/shared" } };
  const ignorePaths = ["configs"];
  assert.deepEqual(scanWorkspace(root, { ignorePaths }), {});
  assert.deepEqual(
    loadKnownApps(roots, apps, "development", ignorePaths).map(({ folder }) => folder),
    [owner],
  );
});

test("a Vite launch with an explicit config still hides helpers of its unused Rslib config", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-rslib-shadowed-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shared = path.join(root, "shared");
  fs.mkdirSync(shared);
  fs.writeFileSync(path.join(root, "package.json"), '{"scripts":{"dev":"vite -c vite.config.ts"}}');
  fs.writeFileSync(
    path.join(root, "vite.config.ts"),
    `export default { plugins: [pluginModuleFederation({ name: 'web' })] };`,
  );
  fs.writeFileSync(
    path.join(root, "rslib.config.ts"),
    `import mf from './shared/module-federation.config';
    export default { lib: [{ format: 'mf', plugins: [pluginModuleFederation(mf)] }] };`,
  );
  fs.writeFileSync(
    path.join(shared, "module-federation.config.ts"),
    `export default { name: 'library' };`,
  );
  assert.deepEqual(Object.keys(scanWorkspace(root)), ["web"]);
});

test("an explicit override hides helpers of the Rslib config selected by the start script", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-rslib-config-override-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "package.json"),
    '{"scripts":{"dev":"rslib mf-dev -c mf-entry.ts"}}',
  );
  fs.writeFileSync(
    path.join(root, "mf-entry.ts"),
    `import mf from './module-federation.config';
    export default { lib: [{ format: 'mf', plugins: [pluginModuleFederation(mf)] }] };`,
  );
  fs.writeFileSync(
    path.join(root, "module-federation.config.ts"),
    `export default { name: 'library' };`,
  );
  fs.writeFileSync(path.join(root, "vite.config.ts"), `export default { server: { port: 4173 } };`);
  assert.equal(readAppFolder(root, "development")?.name, "library");
  assert.equal(
    readAppFolder(root, "development", "library", undefined, undefined, "dev", "vite.config.ts"),
    null,
  );
});

test("Rslib leaves federation configs standalone when only imported or reexported", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-rslib-type-only-import-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  for (const name of ["typedImport", "typedExport", "mixedImport", "mixedExport"]) {
    const folder = path.join(root, name);
    fs.mkdirSync(folder);
    fs.writeFileSync(
      path.join(folder, "module-federation.config.ts"),
      `export type FederationOptions = {}; export const value = 1; export default { name: '${name}' };`,
    );
  }
  fs.writeFileSync(
    path.join(root, "rslib.config.ts"),
    `import { type FederationOptions } from './typedImport/module-federation.config';
    export { type FederationOptions } from './typedExport/module-federation.config';
    import { type FederationOptions as Mixed, value } from './mixedImport/module-federation.config';
    export { type FederationOptions as MixedExport, value } from './mixedExport/module-federation.config';
    export default { lib: [{ format: 'esm' }] };`,
  );
  assert.deepEqual(Object.keys(scanWorkspace(root)), [
    "mixedExport",
    "mixedImport",
    "typedExport",
    "typedImport",
  ]);
});

test("Windows Rslib scripts accept native config, root and env paths", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-windows-launch-path-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  t.after(() => Object.defineProperty(process, "platform", platform));
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  const pkg = path.join(root, "package.json");
  const script = String.raw`rslib mf-dev --root C:\Work\App --config .\configs\rslib.config.ts --env-dir=C:\Work\App\env`;
  fs.writeFileSync(pkg, JSON.stringify({ scripts: { dev: script } }));
  const launch = readLaunchScript(root, "dev");
  assert.equal(launch?.root, String.raw`C:\Work\App`);
  assert.equal(launch?.configFile, String.raw`.\configs\rslib.config.ts`);
  assert.equal(launch?.envDir, String.raw`C:\Work\App\env`);
  fs.writeFileSync(pkg, JSON.stringify({ scripts: { dev: script + " & echo ignored" } }));
  assert.equal(readLaunchScript(root, "dev"), null);
});

test("Rslib tracks --env-dir files through configured refresh", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-rslib-env-dir-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "app");
  fs.mkdirSync(app);
  const pkg = path.join(app, "package.json");
  const writeScript = (dev: string) => fs.writeFileSync(pkg, JSON.stringify({ scripts: { dev } }));
  writeScript("rslib --env-dir env mf-dev --env-mode review");
  fs.writeFileSync(path.join(app, ".env.review"), "MF_NAME=wrong\nPORT=9001\n");
  fs.writeFileSync(
    path.join(app, "rslib.config.ts"),
    `export default { server: { port: process.env.PORT },
      lib: [{ format: 'mf', plugins: [pluginModuleFederation({ name: process.env.MF_NAME })] }] };`,
  );
  const roots = [{ name: "root", path: root }];
  const cache = createAppParseCache();
  const load = () =>
    loadKnownApps(roots, { library: { path: "app" } }, "development", [], cache)[0];
  assert.equal(load(), undefined);
  const envDir = path.join(app, "env");
  fs.mkdirSync(envDir);
  const envFile = path.join(envDir, ".env.review");
  fs.writeFileSync(envFile, "MF_NAME=library\nPORT=9002\n");
  assert.equal(scanWorkspace(root).library?.port, 9002);
  assert.equal(load()?.port, 9002);
  fs.writeFileSync(envFile, "MF_NAME=library\nPORT=19003\n");
  assert.equal(load()?.launchEnvironment?.env.PORT, "19003");
  writeScript(`rslib mf-dev --env-dir=${envDir} --env-mode review`);
  assert.equal(load()?.port, 19003);
  if (process.platform === "win32") {
    const alternate = path.join(root, "APP", "env").replaceAll("\\", "/");
    writeScript(`rslib mf-dev --env-dir=${alternate} --env-mode review`);
    assert.equal(load()?.port, 19003);
  }
  const envPackage = path.join(envDir, "package.json");
  fs.writeFileSync(envPackage, "{}");
  assert.equal(load(), undefined);
  fs.unlinkSync(envPackage);
  assert.equal(load()?.port, 19003);
  writeScript("MF_NAME=library rslib mf-dev --env-dir=../env --env-mode review --no-env");
  assert.deepEqual(load()?.launchEnvironment?.env, { MF_NAME: "library" });
});

test("a recognized Rslib launch selects the first default config unless a config is specified", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-rslib-default-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), '{"scripts":{"dev":"rslib mf-dev"}}');
  const shared = path.join(root, "shared");
  fs.mkdirSync(shared);
  fs.writeFileSync(
    path.join(root, "rslib.config.mjs"),
    `export default { lib: [{ format: 'esm' }] };`,
  );
  fs.writeFileSync(
    path.join(root, "rslib.config.ts"),
    `
    import mf from './shared/module-federation.config';
    export default { lib: [{ format: 'mf', plugins: [pluginModuleFederation(mf)] }] };`,
  );
  fs.writeFileSync(
    path.join(shared, "module-federation.config.ts"),
    `export default { name: 'library' };`,
  );
  assert.deepEqual(scanWorkspace(root), {});
  fs.writeFileSync(
    path.join(root, "package.json"),
    '{"scripts":{"dev":"rslib mf-dev -c rslib.config.mjs"}}',
  );
  assert.deepEqual(scanWorkspace(root), {});
  fs.writeFileSync(path.join(root, "package.json"), '{"scripts":{"dev":"rslib mf-dev"}}');
  assert.equal(
    readAppFolder(root, "development", "library", undefined, undefined, "dev", "rslib.config.ts")
      ?.name,
    "library",
  );
  fs.renameSync(path.join(root, "rslib.config.mjs"), path.join(root, "actual.mjs"));
  fs.symlinkSync("actual.mjs", path.join(root, "rslib.config.mjs"), "file");
  assert.deepEqual(scanWorkspace(root), {});
  fs.unlinkSync(path.join(root, "rslib.config.mjs"));
  assert.equal(scanWorkspace(root).library?.name, "library");
});

test("the dev script selects the same-name app and its port from Rslib or Vite", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-rslib-port-origin-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), '{"scripts":{"dev":"rslib mf-dev"}}');
  fs.writeFileSync(
    path.join(root, "rslib.config.ts"),
    `
    export default {
      server: { port: process.env.PORT }, devServer: { port: 9991 },
      lib: [{ format: 'mf', server: { port: 9992 }, plugins: [pluginModuleFederation({ name: 'library' })] }],
    };`,
  );
  fs.writeFileSync(
    path.join(root, "vite.config.ts"),
    `
    export default { server: { port: process.env.PORT ?? 8888 }, plugins: [pluginModuleFederation({ name: 'library' })] };`,
  );
  const library = scanWorkspace(root).library;
  assert.equal(library?.bundler, "rslib");
  assert.equal(library.port, 3000);
  const rslibConfig = path.join(root, "rslib.config.ts");
  const original = fs.readFileSync(rslibConfig, "utf8");
  fs.writeFileSync(rslibConfig, original.replace("process.env.PORT", "undefined"));
  assert.equal(scanWorkspace(root).library?.port, 3000);
  fs.writeFileSync(rslibConfig, original.replace("process.env.PORT", "opaque()"));
  assert.equal(scanWorkspace(root).library?.port, null);
  fs.writeFileSync(rslibConfig, original);
  fs.writeFileSync(path.join(root, "package.json"), '{"scripts":{"dev":"PORT=4567 vite"}}');
  const web = scanWorkspace(root).library;
  assert.equal(web?.configFile, path.join(root, "vite.config.ts"));
  assert.equal(web.port, 4567);
  assert.equal(web.launchEnvironment?.env.PORT, "4567");
});

test("a separate federation config keeps its active Vite or Rsbuild server beside same-name Rslib", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-rslib-standalone-launch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const standalone = path.join(root, "module-federation.config.ts");
  fs.writeFileSync(
    standalone,
    `export default { name: 'web', remotes: { alpha: 'alpha@http://localhost:3001/mf-manifest.json' } };`,
  );
  fs.writeFileSync(
    path.join(root, "rslib.config.ts"),
    `export default { server: { port: 4600 }, lib: [{ format: 'mf', plugins: [pluginModuleFederation({ name: 'web' })] }] };`,
  );
  for (const [bundler, command, manifestPath] of [
    ["vite", "vite", "/preview/mf-manifest.json"],
    ["rsbuild", "rsbuild dev", "/fixtures/mf-manifest.json"],
  ]) {
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { dev: command } }),
    );
    const config = path.join(root, `${bundler}.config.ts`);
    fs.writeFileSync(
      config,
      `export default { base: '/preview/', server: { port: 4500, base: '/fixtures/' } };`,
    );
    const web = scanWorkspace(root).web;
    assert.equal(web.configFile, standalone);
    assert.equal(web.port, 4500);
    assert.equal(web.remotes[0]?.alias, "alpha");
    assert.equal(web.manifestPath, manifestPath);
    fs.unlinkSync(config);
  }
});

test("an active Vite launch keeps the federation config it shares with an alternate Rslib config", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-rslib-shared-vite-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = path.join(root, "package.json");
  fs.writeFileSync(
    path.join(root, "module-federation.config.ts"),
    `export default { name: 'web', dts: true };`,
  );
  fs.writeFileSync(path.join(root, "vite.config.ts"), `export default { server: { port: 4500 } };`);
  fs.writeFileSync(
    path.join(root, "rslib.config.ts"),
    `
    import mf from './module-federation.config';
    export default { server: { port: 4600 }, lib: [{ format: 'mf', plugins: [pluginModuleFederation(mf)] }] };
  `,
  );
  const load = () =>
    loadKnownApps([{ name: "root", path: root }], { web: { path: "." } }, "development")[0];
  for (const dev of ["vite", "vite -c vite.config.ts", "rslib mf-dev"]) {
    fs.writeFileSync(pkg, JSON.stringify({ scripts: { dev } }));
    const port = dev.startsWith("vite") ? 4500 : 4600;
    assert.equal(scanWorkspace(root).web?.port, port);
    assert.equal(load()?.port, port);
  }
  fs.writeFileSync(pkg, JSON.stringify({ scripts: { dev: "vite" } }));
  fs.writeFileSync(
    path.join(root, "module-federation.config.ts"),
    `export default { name: 'library', dts: true };`,
  );
  fs.writeFileSync(
    path.join(root, "vite.config.ts"),
    `
    export default { server: { port: 4500 }, plugins: [pluginModuleFederation({ name: 'web' })] };
  `,
  );
  const apps = scanWorkspace(root);
  assert.equal(apps.web?.port, 4500);
  assert.equal(apps.library?.port, 4600);
  assert.equal(apps.library.bundler, "rslib");
  assert.equal(readAppFolder(root, "development", "library")?.bundler, "rslib");
});

test("an independent Rslib app does not affect standalone Rsbuild metadata", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-rslib-independent-launch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), '{"scripts":{"dev":"rsbuild dev"}}');
  fs.writeFileSync(
    path.join(root, "module-federation.config.ts"),
    `export default { name: 'web', dts: true };`,
  );
  fs.writeFileSync(
    path.join(root, "rsbuild.config.ts"),
    `
    export default { server: { port: 4500, base: '/web/' }, output: { distPath: { root: 'build' } } };
  `,
  );
  fs.writeFileSync(
    path.join(root, "rslib.config.ts"),
    `
    export default { lib: [{ format: 'mf', plugins: [pluginModuleFederation({ name: 'library' })] }] };
  `,
  );
  const { web, library } = scanWorkspace(root);
  assert.equal(web.port, 4500);
  assert.equal(web.manifestPath, "/web/mf-manifest.json");
  assert.equal(web.generatedZipPath, path.join(root, "build", "@mf-types.zip"));
  assert.equal(library.bundler, "rslib");
});

test("discovery ignores a symlink or directory in place of a mode env file", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-env-input-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const alpha = path.join(root, "alpha");
  const beta = path.join(root, "beta");
  for (const folder of [alpha, beta]) {
    fs.mkdirSync(folder);
    fs.writeFileSync(
      path.join(folder, "rsbuild.config.ts"),
      `export default {
      name: '${path.basename(folder)}', server: { port: process.env.LISTENER ?? 4620 },
    };`,
    );
  }
  const outside = path.join(root, "unrelated.env");
  fs.writeFileSync(outside, "LISTENER=4699\n");
  fs.symlinkSync(outside, path.join(alpha, ".env.development.local"), "file");
  fs.mkdirSync(path.join(beta, ".env.development.local"));
  const apps = scanWorkspace(root);
  assert.deepEqual(
    Object.values(apps).map(({ port }) => port),
    [4620, 4620],
  );
});

test("an unknown or mutated port cannot come from an unrelated bundler config", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-port-origin-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "rsbuild.config.ts"),
    `
    const listener = {port: 4621}; Object.assign?.(listener, {port: 4622});
    export default { name: 'palette', server: listener };
  `,
  );
  fs.writeFileSync(path.join(root, "vite.config.ts"), "export default { server: { port: 4699 } };");
  assert.equal(scanWorkspace(root).palette.port, null);
});

test("two packages can select the same config with separate launch contexts", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-config-context-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nested = path.join(root, "nested");
  fs.mkdirSync(nested);
  fs.writeFileSync(
    path.join(root, "package.json"),
    '{"scripts":{"dev":"cross-env FEDERATION_ID=grove rsbuild dev --config nested/vite.config.ts"}}',
  );
  fs.writeFileSync(
    path.join(nested, "package.json"),
    '{"scripts":{"dev":"cross-env FEDERATION_ID=seed vite"}}',
  );
  fs.writeFileSync(
    path.join(nested, "vite.config.ts"),
    `export default defineConfig(({ command }) => ({
    server: {port: command === 'dev' ? 4617 : 4618},
    plugins: [pluginModuleFederation({name:process.env.FEDERATION_ID})],
  }));`,
  );
  const apps = scanWorkspace(root);
  assert.deepEqual(
    Object.values(apps).map(({ name, folder, port }) => [name, folder, port]),
    [
      ["grove", root, 4617],
      ["seed", nested, 4618],
    ],
  );
});

test("repeated scalar references stop at the evaluation budget", () => {
  const aliases = Array.from(
    { length: 24 },
    (_, index) => `const item${index + 1} = item${index} + item${index};`,
  ).join("\n");
  const source = `const item0 = 1; ${aliases}
    export default { name: 'loom', server: { port: item24 === 16777216 ? 4620 : 4621 } };`;
  const app = discoverSource(source, "/example/module-federation.config.ts", {});
  assert.equal(app?.name, "loom");
  assert.equal(app.port, null);
});

test("invalid server ports are ignored", () => {
  for (const port of [0, 65536, 1.5]) {
    const source = `export default { server: { port: ${port} }, plugins: [pluginModuleFederation({ name: "app" })] };`;
    assert.equal(discoverSource(source, "/widget-1/rsbuild.config.ts", {})?.port, null);
  }
});

test("static ports handle guarded fallback, tuple bindings, spreads and shadowed conversions", () => {
  const source = `
    const [missing, primary = 4617] = [null];
    const endpoints = {};
    function choose(value: number) { if (value === 4617) return value; return 4618; }
    const inputs = [primary];
    export default defineConfig(({ command }) => ({
      server: { port: command === 'serve' ? (missing?.target.port ?? endpoints.port?.() ?? choose(...inputs)) : 4619 },
      plugins: [pluginModuleFederation({ name: 'paper' })],
    }));
  `;
  assert.equal(discoverSource(source, "/example/vite.config.ts", {})?.port, 4617);
  const shadowed = `const Number = () => 4621; export default { name: 'paper', server: {port: Number('4617')} };`;
  assert.equal(discoverSource(shadowed, "/example/module-federation.config.ts", {})?.port, 4621);
  const invalid = `export default { name: 'paper', server: {port: Number('4617x')} };`;
  assert.equal(discoverSource(invalid, "/example/module-federation.config.ts", {})?.port, null);
});

test("devServer.port is read and explicit false dts stays off", () => {
  const source = `
    new ModuleFederationPlugin({
      name: "app",
      manifest: false,
      dts: { generateTypes: false, consumeTypes: false },
    });
    export default { devServer: { port: 8080 } };
  `;
  const app = discoverSource(source, "/widget-1/webpack.config.ts", {});
  assert.equal(app?.name, "app");
  assert.equal(app?.port, 8080);
  assert.equal(app?.manifest, false);
  assert.equal(app?.generateTypes, false);
  assert.equal(app?.consumeTypes, false);
  assert.equal(app?.compilerInstance, null);
});

test("consumeTypes typesFolder overrides the default", () => {
  const source = `
    pluginModuleFederation({
      name: "app",
      manifest: { fileName: "custom-manifest.json" },
      dts: { generateTypes: true, consumeTypes: { typesFolder: "federated-types" } },
    });
  `;
  const app = discoverSource(source, "/widget-1/rsbuild.config.ts", {});
  assert.equal(app?.typesFolder, "federated-types");
  assert.equal(app?.manifestPath, "/custom-manifest.json");
  assert.equal(app?.generateTypes, true);
  assert.equal(app?.consumeTypes, true);
});

test("scanWorkspace skips node_modules, .git, dist, and extra segments", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-scan-"));
  try {
    writeApp(path.join(root, "kept"), "kept");
    writeApp(path.join(root, "node_modules", "pkg"), "fromModules");
    writeApp(path.join(root, ".git"), "fromGit");
    writeApp(path.join(root, "dist"), "fromDist");
    writeApp(path.join(root, "vendor"), "fromVendor");
    writeApp(path.join(root, "nested", "skip-me"), "fromNested");
    const found = scanWorkspace(root, { ignorePaths: ["vendor", "nested/skip-me"] });
    assert.deepEqual(Object.keys(found), ["kept"]);
    assert.equal(found.kept?.folder, path.join(root, "kept"));
    assert.equal(found.kept?.configFile, path.join(root, "kept", "rsbuild.config.ts"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the microfrontend entity does not import vscode", () => {
  const discover = fs.readFileSync(
    new URL("../src/entities/microfrontend/lib/discover.ts", import.meta.url),
    "utf8",
  );
  const index = fs.readFileSync(
    new URL("../src/entities/microfrontend/index.ts", import.meta.url),
    "utf8",
  );
  assert.equal(/\bfrom\s+["']vscode["']/.test(discover), false);
  assert.equal(/\bfrom\s+["']vscode["']/.test(index), false);
  assert.equal(discover.includes("mf-dashboard"), false);
});

function writeApp(dir: string, name: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "rsbuild.config.ts"),
    `
    pluginModuleFederation({ name: "${name}", manifest: true });
  `,
  );
}

test("discovery preserves comments, regex, types, env templates and missing values", () => {
  const source =
    "\ufeff" +
    `
    // pluginModuleFederation({ name: "comment" });
    const ignored = /[{}]/g;
    const envName: string = process.env.APP_NAME ?? "fallback";
    const remote = \`widget@http://\${process.env.HOST}:4200/mf-manifest.json\`;
    export default { server: { port: process.env.PORT ?? "4100", base: "/assets" },
      plugins: [pluginModuleFederation({ name: envName, manifest: true,
        dts: { generateTypes: { tsConfigPath: "tsconfig.types.json" }, consumeTypes: false },
        remotes: { widget: remote, unknown: process.env.UNKNOWN } })] };
  `;
  const found = discoverSource(source, "/app/rsbuild.config.ts", {
    APP_NAME: "shell",
    HOST: "localhost",
  });
  assert.equal(found?.name, "shell");
  assert.equal(found?.port, 4100);
  assert.equal(found?.manifestPath, "/assets/mf-manifest.json");
  assert.equal(found?.tsconfig, "tsconfig.types.json");
  assert.equal(found?.consumeTypes, false);
  assert.deepEqual(found?.remotes, [
    { alias: "widget", name: "widget", url: "http://localhost:4200/mf-manifest.json" },
    { alias: "unknown", name: "unknown", url: null },
  ]);
});

test("Vite resolves a local manifest path from base and the federation manifest options", () => {
  for (const [expression, expected] of [
    ["import.meta.env.PREVIEW_MOUNT", "/preview/metadata/catalog.json"],
    ["process.env.CATALOG_ROUTE", "/catalog/metadata/catalog.json"],
    ["'https://cdn.example.test/deploy/'", "/deploy/metadata/catalog.json"],
    ["'/preview/?v=1'", "/preview/metadata/catalog.json"],
    ["'/preview//v2/'", "/preview//v2/metadata/catalog.json"],
    ["'./'", "/metadata/catalog.json"],
    ["undefined", "/metadata/catalog.json"],
  ]) {
    const source = `
      import { federation } from '@module-federation/vite';
      export default {
        base: ${expression},
        server: { port: 4400 },
        plugins: [federation({
          name: 'catalog',
          manifest: { filePath: 'metadata', fileName: 'catalog.json' },
        })],
      };`;
    assert.equal(
      discoverSource(source, "/example/vite.config.ts", {
        PREVIEW_MOUNT: "/preview/",
        CATALOG_ROUTE: "/catalog/",
      })?.manifestPath,
      expected,
      expression,
    );
  }
});

test("an explicitly configured Vite file gets its manifest route without a standard filename", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-vite-custom-manifest-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, ".env.development"), "CATALOG_MOUNT=/preview/\n");
  fs.writeFileSync(path.join(root, "package.json"), '{"scripts":{"dev":"npm run dev:frontend"}}');
  fs.writeFileSync(
    path.join(root, "catalog.config.ts"),
    `import { federation as catalogPlugin } from '@module-federation/vite';
    export default {
      base: import.meta.env.CATALOG_MOUNT,
      server: { port: 4400 },
      plugins: [catalogPlugin({
        name: 'catalog', manifest: { filePath: 'metadata', fileName: 'catalog.json' },
      })],
    };`,
  );
  const app = readAppFolder(
    root,
    "development",
    "catalog",
    undefined,
    undefined,
    "dev",
    "catalog.config.ts",
  );
  assert.equal(app?.manifestPath, "/preview/metadata/catalog.json");
});

test("Vite uses the manifest options passed to the plugin when it imports a federation config", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-vite-manifest-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), '{"scripts":{"dev":"vite"}}');
  const federationConfig = path.join(root, "module-federation.config.ts");
  const writeFederation = (manifest: string) =>
    fs.writeFileSync(
      federationConfig,
      `export default { name: 'catalog', manifest: ${manifest} };`,
    );
  writeFederation("{ filePath: 'metadata', fileName: 'catalog.json' }");
  const writeRsbuild = (name: string) =>
    fs.writeFileSync(
      path.join(root, "rsbuild.config.ts"),
      `export default { server: { port: 4600, base: '/other/' },
        plugins: [pluginModuleFederation({ name: ${JSON.stringify(name)}, manifest: true })] };`,
    );
  const viteConfig = path.join(root, "vite.config.ts");
  fs.writeFileSync(viteConfig, `export default { base: '/vite/', server: { port: 4400 } };`);
  for (const name of ["archive", "catalog"]) {
    writeRsbuild(name);
    for (const app of [
      scanWorkspace(root).catalog,
      readAppFolder(root, "development", "catalog"),
    ]) {
      assert.equal(app?.manifestPath, "/vite/metadata/catalog.json");
      assert.equal(app.port, 4400);
    }
  }
  for (const [manifest, expected] of [
    ["{ filePath: 'runtime', fileName: 'live.json' }", "/vite/runtime/live.json"],
    ["false", "/vite/mf-manifest.json"],
  ]) {
    writeFederation(manifest === "false" ? "true" : "false");
    fs.writeFileSync(
      viteConfig,
      `import { federation } from '@module-federation/vite';
      import mf from './module-federation.config';
      export default {
        base: '/vite/',
        server: { port: 4400 },
        plugins: [federation({ ...mf, manifest: ${manifest} })],
      };`,
    );
    for (const app of [scanWorkspace(root).catalog, readAppFolder(root, "development")]) {
      assert.equal(app?.manifestPath, expected);
      assert.equal(app.manifest, manifest !== "false");
      assert.equal(app.port, 4400);
    }
  }
});

test("active Vite uses its default config order and honors an explicit config", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-vite-config-order-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [extension, port, base] of [
    ["js", 4400, "/selected/"],
    ["cjs", 4410, "/alternate/"],
  ]) {
    fs.writeFileSync(
      path.join(root, `vite.config.${extension}`),
      `export default { base: '${base}', server: { port: ${port} }, plugins: [federation({
        name: 'catalog', manifest: { fileName: 'index.json' },
      })] };`,
    );
  }
  for (const [dev, port, manifest] of [
    ["vite", 4400, "/selected/index.json"],
    ["vite -c vite.config.cjs", 4410, "/alternate/index.json"],
    ["vite --base /override/", 4400, "/override/index.json"],
    ["vite -c vite.config.cjs --base=/override/", 4410, "/override/index.json"],
  ]) {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { dev } }));
    for (const app of [scanWorkspace(root).catalog, readAppFolder(root, "development")]) {
      assert.equal(app?.manifestPath, manifest);
      assert.equal(app.port, port);
    }
  }
});

test("Rsbuild appends the manifest extension before joining the directory", () => {
  const app = discoverSource(
    `export default { plugins: [pluginModuleFederation({
      name: 'catalog', manifest: { filePath: 'metadata', fileName: '.' },
    })] };`,
    "/example/rsbuild.config.ts",
    {},
  );
  assert.equal(app?.manifestPath, "/metadata/..json");
});

test("direct remote URLs keep at signs in the path and query", () => {
  const url = "http://localhost:4620/artifacts/@preview/mf-manifest.json?rev=a@b";
  const source = `export default {
    name: "sketchbook",
    remotes: {
      icons: " ${url} ",
      shapes: { entry: "vector@${url}" },
      brushes: { external: "${url}" },
      palettes: \`http://localhost:4620/artifacts/@preview/\${process.env.RELEASE_SEGMENT}.json\`,
    },
  };`;
  assert.deepEqual(discoverSource(source, "/example/module-federation.config.ts", {})?.remotes, [
    { alias: "icons", name: "icons", url },
    { alias: "shapes", name: "vector", url },
    { alias: "brushes", name: "brushes", url },
    { alias: "palettes", name: "palettes", url: null },
  ]);
});

test("discovery follows local reexports and combines a separate bundler config without executing it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-import-scan-"));
  try {
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    fs.writeFileSync(
      path.join(root, "options.ts"),
      `
      throw new Error("configuration must not execute");
      export function federation() {
        return { name: "shell", manifest: { fileName: "fixture-manifest.json" }, dts: true };
      }
    `,
    );
    fs.writeFileSync(
      path.join(root, "bridge.ts"),
      'export { federation as createFederation } from "./options";',
    );
    const config = path.join(root, "module-federation.config.ts");
    fs.writeFileSync(
      config,
      'import { createFederation } from "./bridge"; createModuleFederationConfig(createFederation());',
    );
    fs.writeFileSync(
      path.join(root, "rsbuild.config.ts"),
      `export default {
        server: { port: 4100, base: "/fixture-base/", proxy: { "/api": "https://api.example.test/" } },
        dev: { assetPrefix: "/fixture-base/assets/" },
        output: { distPath: { root: "build/custom" } }
      };`,
    );
    const found = scanWorkspace(root);
    assert.equal(found.shell?.name, "shell");
    assert.equal(found.shell?.port, 4100);
    assert.equal(found.shell?.manifestPath, "/fixture-base/fixture-manifest.json");
    assert.equal(found.shell?.devManifestPath, "/fixture-base/assets/fixture-manifest.json");
    assert.equal(found.shell?.configFile, path.join(root, "options.ts"));
    assert.equal(found.shell?.generateTypes, true);
    assert.equal(found.shell?.generatedZipPath, path.join(root, "build/custom/@mf-types.zip"));
    fs.writeFileSync(
      path.join(root, "options.ts"),
      'export function federation() { return { name: "shell", dts: { generateTypes: { outputDir: "custom-types", typesFolder: "shell-types" } } }; }',
    );
    assert.equal(
      scanWorkspace(root).shell?.generatedZipPath,
      path.join(root, "custom-types/shell-types.zip"),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a matched Rsbuild config supplies the manifest route beside an unrelated bundler config", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-split-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "module-federation.config.ts"),
    `export default {
      name: "fixture-paired", manifest: { filePath: "./metadata/", fileName: "fixture" }, dts: true
    };`,
  );
  const rsbuildConfig = path.join(root, "rsbuild.config.ts");
  fs.writeFileSync(path.join(root, "rspack.config.ts"), 'export default { mode: "development" };');
  for (const [prefix, server] of [
    ["http://localhost:<port>/fixture-base/assets/", { port: 53950 }],
    ["//localhost:<port>/fixture-base/assets/", { port: 53950 }],
    ["//localhost/fixture-base/assets/", { port: 443, https: { allowHTTP1: true } }],
  ] as const) {
    fs.writeFileSync(
      rsbuildConfig,
      `
import options from "./module-federation.config";
export default {
  server: ${JSON.stringify({ ...server, base: "/fixture-base/" })},
  dev: { assetPrefix: ${JSON.stringify(prefix)} },
  plugins: [pluginModuleFederation(options)]
};
`,
    );
    const app = scanWorkspace(root)["fixture-paired"];
    assert.equal(app?.buildConfigFile, rsbuildConfig);
    assert.equal(app?.manifestPath, "/fixture-base/metadata/fixture.json");
    assert.equal(app?.devManifestPath, "/fixture-base/assets/metadata/fixture.json", prefix);
  }
});

test("Rsbuild dev asset routes stay on the same local server and under its base", () => {
  for (const prefix of [
    "http://assets.example.test:53950/fixture-base/assets/",
    "//assets.example.test:53950/fixture-base/assets/",
    "http://localhost:53951/fixture-base/assets/",
    "/fixture-base-proxy/",
    "http://localhost:<port>/fixture-base-proxy/",
    "/fixture-base/%2e%2e/fixture-base-proxy/",
  ]) {
    const source = `export default {
      server: { port: 53950, base: "/fixture-base/",
        proxy: { "/fixture-base-proxy/": "https://assets.example.test/" }
      },
      dev: { assetPrefix: ${JSON.stringify(prefix)} },
      plugins: [pluginModuleFederation({ name: "fixture-remote-assets", manifest: true })]
    };`;
    const app = discoverSource(source, "/fixture/rsbuild.config.ts", {});
    assert.equal(app?.manifestPath, "/fixture-base/mf-manifest.json");
    assert.equal(app?.devManifestPath, undefined, prefix);
  }
});

test("Rsbuild proxy rules that may handle the manifest keep its asset route remote", () => {
  const target = "https://assets.example.test/";
  for (const proxy of [
    { "/fixture-base/assets/": target },
    { "/fixture-base/assets/mf-manifest.json": target },
    { "/api": { target, pathFilter: "/fixture-base/assets/" } },
    [{ context: "/fixture-base/assets/", target }],
  ]) {
    const source = `export default {
      server: { port: 53950, base: "/fixture-base/", proxy: ${JSON.stringify(proxy)} },
      dev: { assetPrefix: "/fixture-base/assets/" },
      plugins: [pluginModuleFederation({ name: "fixture-proxied-assets", manifest: true })]
    };`;
    const app = discoverSource(source, "/fixture/rsbuild.config.ts", {});
    assert.equal(app?.manifestPath, "/fixture-base/mf-manifest.json");
    assert.equal(app?.devManifestPath, undefined, JSON.stringify(proxy));
  }
});

test("an unresolved environment condition can route a Rsbuild dev manifest through a proxy", () => {
  const source = `
    const proxyEnabled = process.env.NODE_ENV === "development" && process.env.FIXTURE_PROXY !== "off";
    export default {
      server: { port: 53950, base: "/fixture-base/",
        proxy: proxyEnabled ? { "/fixture-base/assets/": "https://assets.example.test/" } : undefined
      },
      dev: { assetPrefix: "/fixture-base/assets/" },
      plugins: [pluginModuleFederation({ name: "fixture-conditional-proxy", manifest: true })]
    };`;
  const file = "/fixture/rsbuild.config.ts";
  const app = discoverSource(source, file, {});
  assert.equal(app?.manifestPath, "/fixture-base/mf-manifest.json");
  assert.equal(app?.devManifestPath, undefined);
  assert.equal(
    discoverSource(source, file, { NODE_ENV: "development" })?.devManifestPath,
    undefined,
  );
  const direct = discoverSource(source, file, { NODE_ENV: "development", FIXTURE_PROXY: "off" });
  assert.equal(direct?.devManifestPath, "/fixture-base/assets/mf-manifest.json");
});

test("Rsbuild dev asset routes require resolved server settings", () => {
  for (const [server, prefix] of [
    ['{ port: 53950, base: "/FIXTURE-BASE/".toLowerCase() }', "/fixture-other/assets/"],
    ['{ port: 53950, base: "/fixture-base/../fixture-other/" }', "/fixture-other/assets/"],
    ["{ port: 53950, base: process.env.FIXTURE_BASE }", "/fixture-other/assets/"],
    [
      '{ port: process.env.FIXTURE_PORT ?? 53950, base: "/fixture-base/" }',
      "/fixture-base/assets/",
    ],
    [
      '{ port: 80, base: "/fixture-base/", https: readHttpsOptions() }',
      "//localhost/fixture-base/assets/",
    ],
  ]) {
    const source = `export default {
      server: ${server}, dev: { assetPrefix: ${JSON.stringify(prefix)} },
      plugins: [pluginModuleFederation({ name: "fixture-unknown-route", manifest: true })]
    };`;
    const app = discoverSource(source, "/fixture/rsbuild.config.ts", {});
    assert.ok(app);
    assert.equal(app.devManifestPath, undefined, server);
  }
});

test("discovery terminates cyclic local reexports", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-import-cycle-"));
  try {
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    fs.writeFileSync(path.join(root, "a.ts"), 'export * from "./b";');
    fs.writeFileSync(path.join(root, "b.ts"), 'export * from "./a";');
    assert.equal(
      discoverSource(
        'import { federation } from "./a"; pluginModuleFederation(federation());',
        path.join(root, "rsbuild.config.ts"),
        {},
      ),
      null,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
