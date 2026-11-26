import { rebuildLocalArchive } from "../src/features/rebuild-types/lib/generate-on-disk.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  createConfirmationStore,
  installLocalTypesArchive,
  installTypesArchive,
  sourceIdentity,
  treeFingerprint,
} from "../src/entities/federated-types/index.ts";
import {
  createProbeBook,
  discoverSource,
  putLinkResult,
  readAppFolder,
  scanWorkspace,
  type LocalApp,
} from "../src/entities/microfrontend/index.ts";
import { verifyTypeInstalls } from "../src/features/observe-types/lib/verify.ts";
import { rebuildAllTypes } from "../src/features/rebuild-types/lib/all.ts";
import { listCompilerInputs } from "../src/features/rebuild-types/lib/compiler-inputs.ts";
import { inputsFingerprint } from "../src/features/rebuild-types/lib/inputs-fingerprint.ts";
import { rebuildTypes } from "../src/features/rebuild-types/lib/workflow.ts";
import type {
  RebuildAllContext,
  RebuildAppStatus,
} from "../src/features/rebuild-types/models/all.ts";
import {
  generateFederatedTypes,
  generateLocalFederatedTypes,
} from "../src/features/rebuild-types/lib/generate.mts";
import type {
  GenerationTimings,
  LocalGeneratedZip,
  LocalGenerationInput,
} from "../src/features/rebuild-types/models/generate.ts";
import { installRemoteTypes } from "../src/features/refetch-types/lib/remote.ts";
import { createLogger, safeError } from "../src/shared/lib/logging.ts";
import { noLog } from "../src/shared/config/logging.ts";
import { DiagnosticError } from "../src/shared/models/diagnostic-error.ts";
import { loadKnownApps } from "../src/widgets/mf-dashboard-tree/lib/known-apps.ts";
import { createAppParseCache } from "../src/widgets/mf-dashboard-tree/lib/app-parse-cache.ts";
import { resolveRebuildApps } from "../src/widgets/mf-dashboard-tree/lib/rebuild-apps.ts";
import { localApp } from "./support/app.ts";
import { zipFixture } from "./support/zip.ts";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-workspace-types-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const decoder = path.join(root, "node_modules", "adm-zip");
  fs.mkdirSync(decoder, { recursive: true });
  fs.writeFileSync(
    path.join(decoder, "index.js"),
    `
const fs = require("node:fs");
const path = require("node:path");
module.exports = class {
  constructor(bytes) { this.content = bytes.subarray(4); }
  getEntries() { return [{ entryName: "index.d.ts", isDirectory: false }]; }
  extractAllTo(dir) { fs.writeFileSync(path.join(dir, "index.d.ts"), this.content); }
};
`,
  );
  const confirmations = createConfirmationStore();
  function app(name: string, port: number, overrides: Partial<LocalApp> = {}) {
    const folder = path.join(root, name);
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "index.ts"), name);
    return localApp(name, folder, { port, ...overrides });
  }
  function context(apps: readonly LocalApp[], overrides: Partial<RebuildAllContext> = {}) {
    return {
      apps,
      confirmations,
      envMode: "development",
      rebuildCommand: "",
      refetchCommand: "",
      zipPathOverride: () => undefined,
      persist() {},
      ...overrides,
    } satisfies RebuildAllContext;
  }
  return { app, context, confirmations };
}

function writeZip(zipPath: string, content: string) {
  const bytes = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from(content)]);
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  fs.writeFileSync(zipPath, bytes);
  return { zipPath, zipHash: createHash("sha256").update(bytes).digest("hex") };
}

function serveZip(t: TestContext, manifestUrl: string, zipPath: string, beforeZip?: () => void) {
  const publicPath = new URL(".", manifestUrl).href;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    if (String(input) === manifestUrl)
      return Response.json({ metaData: { publicPath, types: { zip: "types.zip" } } });
    assert.equal(String(input), `${publicPath}types.zip`);
    beforeZip?.();
    return new Response(fs.readFileSync(zipPath));
  });
}

function remote(app: LocalApp, alias = app.name) {
  return { alias, name: app.name, url: `http://localhost:${app.port}${app.manifestPath}` };
}

function typeFile(app: LocalApp, alias: string): string {
  return path.join(app.folder, app.typesFolder, alias, "index.d.ts");
}

const unused = {
  async runRebuildCommand() {
    throw new Error("unexpected rebuild command");
  },
  async installRemoteTypes() {
    throw new Error("unexpected HTTP request");
  },
};

function mockGeneration(write: (appDir: string) => LocalGeneratedZip) {
  return (input: LocalGenerationInput) =>
    rebuildLocalArchive(
      input,
      path.join(input.appDir, "dist", "@mf-types.zip"),
      { config: "", files: [] },
      async () => write(input.appDir),
    );
}

function installGeneratorFixture(folder: string, generate: string) {
  const typeScriptPackage = createRequire(import.meta.url).resolve("typescript/package.json");
  const modules = {
    "@module-federation/enhanced/index.js": "",
    "@module-federation/cli/index.js": "",
    "@module-federation/rsbuild-plugin/index.js":
      "module.exports = require(globalThis.__mfFixturePluginAlias);",
    "jiti/index.js": `
exports.createJiti = (_id, { alias }) => (file) => {
  globalThis.__mfFixturePluginAlias = alias["@module-federation/rsbuild-plugin"];
  return require(file);
};
`,
    "@module-federation/sdk/index.js": 'exports.TEMP_DIR = ".federation";',
    "typescript/package.json": JSON.stringify({
      bin: { tsc: path.join(path.dirname(typeScriptPackage), "bin", "tsc") },
    }),
    "@module-federation/dts-plugin/core.js": `
const path = require("node:path");
exports.retrieveRemoteConfig = ({ context, moduleFederationConfig }) => {
  const mapComponentsToExpose = Object.fromEntries(
    Object.entries(moduleFederationConfig.exposes).map(([name, file]) => [name, path.resolve(context, file)])
  );
  return {
    mapComponentsToExpose,
    tsConfig: {
      extends: path.join(context, "tsconfig.json"),
      include: [],
      exclude: [],
      files: Object.values(mapComponentsToExpose)
    }
  };
};
`,
    "@module-federation/dts-plugin/index.js": `
const fs = require("node:fs");
exports.isTSProject = () => true;
exports.normalizeDtsOptions = ({ dts }, _context, defaults) =>
  dts === false ? false : { generateTypes: defaults.defaultGenerateOptions, ...dts };
exports.normalizeGenerateTypesOptions = ({ context, dtsOptions, pluginOptions }) => {
  const { generateTypes } = dtsOptions;
  if (generateTypes === false) return undefined;
  if (generateTypes !== undefined && generateTypes !== true &&
      (generateTypes === null || typeof generateTypes !== "object")) {
    throw new TypeError("Unexpected type for mfOptions.dts.generateTypes");
  }
  return { remote: {
    context, moduleFederationConfig: pluginOptions, abortOnError: false, compileInChildProcess: true,
    ...generateTypes
  } };
};
exports.generateTypesAPI = async ({ dtsManagerOptions }) => {
  ${generate}
  await dtsManagerOptions.remote.afterGenerate?.();
};
`,
  };
  for (const [name, contents] of Object.entries(modules)) {
    const file = path.join(folder, "node_modules", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
}

test("bulk rebuild discovers the active Rslib profile and installs its types before the consumer", async (t) => {
  const f = fixture(t);
  const seed = f.app("designKit", 3000);
  fs.writeFileSync(
    path.join(seed.folder, "package.json"),
    JSON.stringify({ federation: { entry: "./index.ts" } }),
  );
  fs.writeFileSync(
    path.join(seed.folder, "rslib.config.ts"),
    `
import { defineConfig } from "@rslib/core";
import profile from "./mf-profile";
throw new Error("the extension must not execute this config");
export default defineConfig({
  lib: process.env.NODE_ENV === "development" ? [{ format: "esm" }, ...profile] : [{ format: "esm" }],
  output: { distPath: "dist/shared" },
});`,
  );
  fs.writeFileSync(
    path.join(seed.folder, "module-federation.config.ts"),
    `
import { federation } from "./package.json";
import shared from "external-runtime-config";
export default {
    name: "designKit",
    exposes: {
      ".": federation.entry,
      "./css?inline": "./style.css?inline",
      "./ignored": "./missing.ts?exclude-mf-dts",
      "./also-ignored": { import: ["./missing.ts?exclude-mf-dts"] },
      "./kept": { import: ["./index.ts"] },
    },
    dts: { generateTypes: { compilerInstance: "tspc", tsConfigPath: "types.json" } },
    shared,
};`,
  );
  fs.writeFileSync(
    path.join(seed.folder, "mf-profile.ts"),
    `
import { pluginModuleFederation } from "@module-federation/rsbuild-plugin";
import federation from "./module-federation.config";
export default [{
  format: "mf",
  output: { distPath: { js: "assets" } },
  plugins: [[false, [pluginModuleFederation(federation)]]],
}];`,
  );
  const consumerSeed = f.app("reportingHost", 3004);
  fs.writeFileSync(
    consumerSeed.configFile,
    `
import { pluginModuleFederation } from "@module-federation/rsbuild-plugin";
export default { server: { port: 3004 }, plugins: [pluginModuleFederation({
  name: "reportingHost", dts: true, exposes: { ".": "./index.ts" },
  remotes: { "@fixture/design-kit": "designKit@http://localhost:3000/mf-manifest.json" },
})] };`,
  );
  const { designKit, reportingHost: consumer } = scanWorkspace(path.dirname(seed.folder));
  assert.ok(designKit);
  assert.ok(consumer);
  assert.equal(designKit.port, 3000);
  assert.equal(designKit.generatedZipPath, path.join(seed.folder, "dist/shared/@mf-types.zip"));
  installGeneratorFixture(
    seed.folder,
    `
const { compilerInstance, tsConfigPath, moduleFederationConfig: mf } = dtsManagerOptions.remote;
if (compilerInstance !== "tspc" || tsConfigPath !== "types.json" ||
    mf.exposes["."] !== "./index.ts" || mf.exposes["./css?inline"] !== "./style.css" ||
    "./ignored" in mf.exposes || "./also-ignored" in mf.exposes ||
    mf.exposes["./kept"].import[0] !== "./index.ts" || process.env.NODE_ENV !== "development") {
  throw new Error("the generator did not receive the resolved MF profile");
}
fs.mkdirSync("dist/shared", { recursive: true });
fs.writeFileSync("dist/shared/@mf-types.zip", Buffer.from([0x50, 0x4b, 3, 4, ...Buffer.from("current widget declarations")]));`,
  );
  const report = await rebuildAllTypes(f.context([consumer, designKit]), {
    ...unused,
    async generateLocalFederatedTypes(input) {
      if (input.name === "designKit") return generateLocalFederatedTypes(input);
      assert.equal(
        fs.readFileSync(typeFile(consumer, "@fixture/design-kit"), "utf8"),
        "current widget declarations",
      );
      return mockGeneration((dir) => writeZip(path.join(dir, "dist/@mf-types.zip"), "side menu"))(
        input,
      );
    },
  });
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.rebuilt, ["designKit", "reportingHost"]);
  assert.deepEqual(report.installed, [{ consumer: "reportingHost", alias: "@fixture/design-kit" }]);
});

test("bulk rebuild skips an Rslib app whose exposes are all excluded from DTS", async (t) => {
  const f = fixture(t);
  const { folder } = f.app("designKit", 3000);
  fs.writeFileSync(path.join(folder, "tsconfig.json"), "{}");
  fs.writeFileSync(
    path.join(folder, "rslib.config.ts"),
    `export default { lib: [{ format: 'mf', plugins: [pluginModuleFederation({
      name: 'designKit',
      exposes: {
        './view': './index.ts?exclude-mf-dts',
        './widget': { import: ['./fallback.ts', './index.ts?exclude-mf-dts=true'] },
      },
    })] }] };`,
  );
  const app = readAppFolder(folder, "development");
  assert.ok(app?.generateTypes);
  const progress: string[] = [];
  const report = await rebuildAllTypes(
    f.context([app], {
      progress(name) {
        progress.push(name);
      },
    }),
    {
      ...unused,
      async generateLocalFederatedTypes() {
        throw new Error("unexpected generation for excluded exposes");
      },
    },
  );
  assert.equal(app.hasExposes, false);
  assert.deepEqual(progress, []);
  assert.deepEqual(report, { rebuilt: [], current: [], installed: [], skipped: [], failed: [] });
});

test("Rslib uses its configured project root for DTS and launch folder for env", async (t) => {
  const f = fixture(t);
  const { folder: launchFolder } = f.app("designKit", 9000);
  const folder = path.join(launchFolder, "project");
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(launchFolder, "package.json"), '{"scripts":{"dev":"rslib mf-dev"}}');
  fs.writeFileSync(path.join(launchFolder, ".env.development"), "PORT=9200\n");
  fs.writeFileSync(path.join(folder, ".env.development"), "PORT=9300\n");
  const configFile = path.join(launchFolder, "rslib.config.ts");
  fs.writeFileSync(
    configFile,
    `export default {
    root: 'project', server: { port: process.env.PORT }, output: { distPath: 'artifacts' },
    lib: [{ format: 'mf', plugins: [pluginModuleFederation({ name: 'designKit', exposes: { '.': './index.ts' } })] }],
  };`,
  );
  fs.writeFileSync(path.join(folder, "index.ts"), "export const value = 1;");
  const roots = [{ name: "root", path: launchFolder }];
  const cache = createAppParseCache();
  const load = () =>
    loadKnownApps(roots, { designKit: { path: "." } }, "development", [], cache)[0];
  assert.equal(load()?.generateTypes, false);
  fs.writeFileSync(path.join(folder, "tsconfig.json"), "{}");
  const app = load();
  assert.equal(app?.folder, folder);
  assert.equal(app.launchFolder, launchFolder);
  assert.equal(app.port, 9200);
  assert.equal(app.generateTypes, true);
  assert.equal(app.consumeTypes, true);
  assert.equal(app.generatedZipPath, path.join(folder, "artifacts/@mf-types.zip"));
  installGeneratorFixture(
    launchFolder,
    `
if (fs.realpathSync(dtsManagerOptions.remote.context) !== fs.realpathSync(process.cwd()) ||
    !fs.existsSync("index.ts") || process.env.PORT !== "9200") {
  throw new Error("unexpected Rslib project root or env");
}
fs.mkdirSync("artifacts", { recursive: true });
fs.writeFileSync("artifacts/@mf-types.zip", Buffer.from([0x50, 0x4b, 3, 4, 1]));
  `,
  );
  const report = await rebuildAllTypes(f.context([app]), {
    ...unused,
    generateLocalFederatedTypes,
  });
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.rebuilt, ["designKit"]);
  assert.ok(fs.existsSync(path.join(folder, "artifacts/@mf-types.zip")));
});

test("Rebuild All includes the Rslib target package manifest in its generation inputs", async (t) => {
  const f = fixture(t);
  const { folder: launcher } = f.app("launcher", 4380);
  const folder = path.join(launcher, "project");
  fs.mkdirSync(folder);
  fs.writeFileSync(
    path.join(launcher, "package.json"),
    '{"scripts":{"dev":"rslib mf-dev --root project"}}',
  );
  const manifest = path.join(folder, "package.json");
  fs.writeFileSync(manifest, '{"type":"module"}');
  fs.writeFileSync(path.join(folder, "tsconfig.json"), '{"files":["index.ts"]}');
  fs.writeFileSync(path.join(folder, "index.ts"), "export const value = 1;");
  fs.writeFileSync(
    path.join(folder, "rslib.config.ts"),
    `export default { lib: [{ format: 'mf', plugins: [pluginModuleFederation({
      name: 'widget', exposes: { '.': './index.ts' }
    })] }] };`,
  );
  const load = () => {
    const app = scanWorkspace(launcher).widget;
    assert.equal(app?.folder, folder);
    assert.ok(app.generateTypes);
    return app;
  };
  const run = (write: (appDir: string) => LocalGeneratedZip) =>
    rebuildAllTypes(f.context([load()]), {
      ...unused,
      generateLocalFederatedTypes: mockGeneration(write),
    });
  const write = (appDir: string) =>
    writeZip(path.join(appDir, "dist", "@mf-types.zip"), "declarations");
  assert.deepEqual((await run(write)).rebuilt, ["widget"]);
  assert.deepEqual((await run(write)).current, ["widget"]);
  fs.writeFileSync(manifest, '{"type":"commonjs"}');
  assert.deepEqual((await run(write)).rebuilt, ["widget"]);
  fs.unlinkSync(manifest);
  const report = await run((appDir) => {
    fs.writeFileSync(manifest, '{"type":"module"}');
    return write(appDir);
  });
  assert.deepEqual(report.rebuilt, []);
  assert.match(
    report.failed[0]?.reason ?? "",
    /build configuration changed during type generation/,
  );
});

test("Rebuild All detects changes to root dotenv used by dynamic DTS configs", async (t) => {
  const f = fixture(t);
  const { folder } = f.app("widget", 4380);
  fs.writeFileSync(path.join(folder, "package.json"), '{"scripts":{"dev":"rsbuild dev"}}');
  fs.writeFileSync(
    path.join(folder, "rsbuild.config.ts"),
    `
    export default { plugins: [pluginModuleFederation({
      name: 'widget', exposes: { '.': './index.ts' }, dts: true
    })] };
  `,
  );
  const envFile = path.join(folder, ".env");
  fs.writeFileSync(envFile, "VALUE=first");
  const app = readAppFolder(folder, "development");
  assert.ok(app?.generateTypes);
  const report = await rebuildAllTypes(f.context([app]), {
    ...unused,
    generateLocalFederatedTypes: mockGeneration((appDir) => {
      fs.writeFileSync(envFile, "VALUE=second");
      return writeZip(path.join(appDir, "dist", "@mf-types.zip"), "type references the old value");
    }),
  });
  assert.deepEqual(report.rebuilt, []);
  assert.match(
    report.failed[0]?.reason ?? "",
    /build configuration changed during type generation/,
  );
  assert.equal(f.confirmations.generation(app.name), null);
});

test("Rebuild All fingerprints an in-package manifest symlink and refuses outside targets", (t) => {
  const f = fixture(t);
  const { folder: launcher } = f.app("launcher", 4380);
  const project = path.join(launcher, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(
    path.join(launcher, "package.json"),
    '{"scripts":{"dev":"rslib mf-dev --root project"}}',
  );
  fs.writeFileSync(path.join(project, "tsconfig.json"), "{}");
  fs.writeFileSync(path.join(project, "index.ts"), "export const value = 1;");
  fs.writeFileSync(
    path.join(project, "rslib.config.ts"),
    `export default { lib: [{ format: 'mf', plugins: [pluginModuleFederation({ name: 'widget', exposes: { '.': './index.ts' } })] }] };`,
  );
  const manifest = path.join(project, "package.json");
  const metadata = path.join(project, "package-meta.json");
  fs.writeFileSync(metadata, '{"type":"module"}');
  fs.symlinkSync("package-meta.json", manifest, "file");
  const app = scanWorkspace(launcher).widget;
  assert.equal(app?.folder, project);
  const fingerprint = () => inputsFingerprint(app, f.context([app]), null, "fixture", []);
  const before = fingerprint();
  fs.writeFileSync(metadata, '{"type":"commonjs"}');
  assert.notEqual(fingerprint(), before);

  const outside = path.join(launcher, "outside.json");
  fs.writeFileSync(outside, '{"type":"module"}');
  fs.unlinkSync(manifest);
  fs.symlinkSync(outside, manifest, "file");
  const open = t.mock.method(fs, "openSync");
  const refused = fingerprint();
  fs.writeFileSync(outside, '{"type":"commonjs"}');
  open.mock.resetCalls();
  assert.equal(fingerprint(), refused);
  assert.ok(
    !open.mock.calls.some(({ arguments: [file] }) => file === fs.realpathSync.native(outside)),
  );
});

test("Rebuild All rejects dotenv edits and new priority configs after planning", async (t) => {
  const f = fixture(t);
  const { folder: first } = f.app("first", 4380);
  const { folder: second } = f.app("second", 4381);
  const root = path.dirname(first);
  const entry = path.join(second, ".env");
  for (const [name, folder] of [
    ["first", first],
    ["second", second],
  ]) {
    fs.writeFileSync(path.join(folder, "package.json"), '{"scripts":{"dev":"rslib mf-dev"}}');
    fs.writeFileSync(path.join(folder, ".env"), "FIXTURE_ENTRY=./index.ts\n");
    fs.writeFileSync(path.join(folder, "tsconfig.json"), '{"files":["index.ts","other.ts"]}');
    fs.writeFileSync(path.join(folder, "other.ts"), "export const other = 1;");
    fs.writeFileSync(
      path.join(folder, "rslib.config.ts"),
      `export default { lib: [{ format: 'mf', plugins: [pluginModuleFederation({ name: '${name}', exposes: { '.': process.env.FIXTURE_ENTRY } })] }] };`,
    );
  }
  const load = () =>
    resolveRebuildApps(
      [{ name: "root", path: root }],
      {
        apps: { first: { path: "first" }, second: { path: "second" } },
        envMode: "development",
        ignorePaths: [],
        structure: "tree",
        extraManifestUrls: [],
      },
      noLog,
    ).apps;
  const generated: string[] = [];
  const run = (apps: LocalApp[], editDuringBuild?: () => void) =>
    rebuildAllTypes(f.context(apps), {
      ...unused,
      generateLocalFederatedTypes: mockGeneration((folder) => {
        generated.push(path.basename(folder));
        if (folder === first) editDuringBuild?.();
        return writeZip(path.join(folder, "dist", "@mf-types.zip"), "declarations");
      }),
    });
  const { first: a, second: b } = scanWorkspace(root);
  const report = await run([a, b], () => fs.writeFileSync(entry, "FIXTURE_ENTRY=./other.ts\n"));
  assert.deepEqual(generated, ["first"]);
  assert.deepEqual(report.rebuilt, ["first"]);
  assert.match(
    report.failed.find(({ app }) => app === "second")?.reason ?? "",
    /build configuration changed/,
  );
  assert.equal(f.confirmations.generation("second"), null);
  const stale = load();
  fs.writeFileSync(entry, "FIXTURE_ENTRY=./index.ts\n");
  assert.match(
    (await run(stale)).failed.find(({ app }) => app === "second")?.reason ?? "",
    /build configuration changed/,
  );
  assert.deepEqual((await run(load())).rebuilt, ["second"]);

  fs.writeFileSync(path.join(first, "index.ts"), "export const changed = 1;");
  fs.writeFileSync(path.join(second, "index.ts"), "export const changed = 2;");
  const preferredConfig = path.join(second, "rslib.config.mjs");
  const planned = load();
  assert.equal(
    planned.find(({ name }) => name === "second")?.configFile,
    path.join(second, "rslib.config.ts"),
  );
  const afterConfigAppeared = await run(planned, () => {
    fs.writeFileSync(
      preferredConfig,
      `export default {lib:[{format:'mf',plugins:[pluginModuleFederation({
        name:'second', exposes:{'.':'./other.ts'}
      })]}]};`,
    );
  });
  assert.deepEqual(afterConfigAppeared.rebuilt, ["first"]);
  assert.match(
    afterConfigAppeared.failed.find(({ app }) => app === "second")?.reason ?? "",
    /build configuration changed/,
  );
  const refreshed = load();
  assert.equal(refreshed.find(({ name }) => name === "second")?.configFile, preferredConfig);
  assert.deepEqual((await run(refreshed)).rebuilt, ["second"]);

  fs.unlinkSync(preferredConfig);
  fs.writeFileSync(path.join(second, "package.json"), '{"scripts":{"dev":"node server.js"}}');
  fs.writeFileSync(path.join(first, "index.ts"), "export const changed = 3;");
  const fallbackPlan = load();
  assert.equal(
    fallbackPlan.find(({ name }) => name === "second")?.configFile,
    path.join(second, "rslib.config.ts"),
  );
  const afterFallbackChanged = await run(fallbackPlan, () => {
    fs.writeFileSync(
      preferredConfig,
      `export default {lib:[{format:'mf',plugins:[pluginModuleFederation({
      name:'second', exposes:{'.':'./other.ts'}
    })]}]};`,
    );
  });
  assert.deepEqual(afterFallbackChanged.rebuilt, ["first"]);
  assert.match(afterFallbackChanged.failed[0]?.reason ?? "", /build configuration changed/);
  assert.equal(load().find(({ name }) => name === "second")?.configFile, preferredConfig);
});

test("Rebuild All rejects its old Rsbuild plan when the first Rslib config appears", async (t) => {
  const f = fixture(t);
  const { folder } = f.app("widget", 4380);
  const rsbuild = path.join(folder, "rsbuild.config.ts");
  const rslib = path.join(folder, "rslib.config.mjs");
  fs.writeFileSync(path.join(folder, "package.json"), '{"scripts":{"dev":"node server.js"}}');
  fs.writeFileSync(path.join(folder, "tsconfig.json"), '{"files":["index.ts"]}');
  fs.writeFileSync(
    rsbuild,
    `export default { plugins: [pluginModuleFederation({
      name: 'widget', dts: true, exposes: { '.': './index.ts' }
    })] };`,
  );
  const load = () =>
    resolveRebuildApps(
      [{ name: "root", path: folder }],
      {
        apps: { widget: { path: "." } },
        envMode: "development",
        ignorePaths: [],
        extraManifestUrls: [],
        structure: "tree",
      },
      noLog,
    ).apps[0];
  const planned = load();
  assert.equal(planned.configFile, rsbuild);
  fs.writeFileSync(
    rslib,
    `export default { lib: [{ format: 'mf', plugins: [pluginModuleFederation({
      name: 'widget', dts: true, exposes: { '.': './index.ts' }
    })] }] };`,
  );
  const generatedConfigs: string[] = [];
  const generate = mockGeneration((appDir) =>
    writeZip(path.join(appDir, "dist/@mf-types.zip"), "declarations"),
  );
  const run = (app: LocalApp) =>
    rebuildAllTypes(f.context([app]), {
      ...unused,
      generateLocalFederatedTypes(input) {
        generatedConfigs.push(input.configFile);
        return generate(input);
      },
    });
  const stale = await run(planned);
  assert.deepEqual(stale.rebuilt, []);
  assert.match(stale.failed[0]?.reason ?? "", /build configuration changed/);
  assert.deepEqual(generatedConfigs, []);
  assert.equal(f.confirmations.generation("widget"), null);

  const refreshed = load();
  assert.equal(refreshed.configFile, rslib);
  assert.deepEqual((await run(refreshed)).rebuilt, ["widget"]);
  assert.deepEqual(generatedConfigs, [rslib]);
});

test("Rebuild All validates the planned env directory by identity", async (t) => {
  const f = fixture(t);
  const { folder } = f.app("widget", 4380);
  const selected = path.join(folder, "selected-env");
  const writeScript = (envDir: string) =>
    fs.writeFileSync(
      path.join(folder, "package.json"),
      JSON.stringify({ scripts: { dev: `rslib mf-dev --env-dir ${envDir}` } }),
    );
  writeScript("selected-env");
  fs.writeFileSync(path.join(folder, "tsconfig.json"), "{}");
  fs.writeFileSync(
    path.join(folder, "rslib.config.ts"),
    `export default {
    server: {port: process.env.PORT},
    lib: [{format:'mf', plugins:[pluginModuleFederation({name:'widget', exposes:{'.':'./index.ts'}})]}]
  };`,
  );
  const load = () =>
    resolveRebuildApps(
      [{ name: "root", path: folder }],
      {
        apps: { widget: { path: "." } },
        envMode: "development",
        ignorePaths: [],
        extraManifestUrls: [],
        structure: "tree",
      },
      noLog,
    ).apps[0];
  const generate = t.mock.fn(
    mockGeneration((root) => writeZip(path.join(root, "dist/@mf-types.zip"), "declarations")),
  );
  const run = (app: LocalApp) =>
    rebuildAllTypes(f.context([app]), { ...unused, generateLocalFederatedTypes: generate });
  const missing = load();
  assert.equal(missing.port, 3000);
  fs.mkdirSync(selected);
  fs.writeFileSync(path.join(selected, ".env"), "PORT=3002\n");
  assert.match((await run(missing)).failed[0]?.reason ?? "", /build configuration changed/);
  assert.equal(generate.mock.callCount(), 0);
  assert.equal(load().port, 3002);

  fs.renameSync(selected, path.join(folder, "first-env"));
  fs.mkdirSync(path.join(folder, "second-env"));
  fs.writeFileSync(path.join(folder, "second-env", ".env"), "PORT=3003\n");
  fs.symlinkSync(path.join(folder, "first-env"), selected, "junction");
  const linked = load();
  assert.equal(linked.port, 3002);
  fs.unlinkSync(selected);
  fs.symlinkSync(path.join(folder, "second-env"), selected, "junction");
  assert.match((await run(linked)).failed[0]?.reason ?? "", /build configuration changed/);
  assert.equal(generate.mock.callCount(), 0);
  assert.equal(load().port, 3003);

  writeScript(".");
  assert.deepEqual((await run(load())).rebuilt, ["widget"]);
});

test("Rebuild All detects a rejected dotenv candidate becoming a file during generation", async (t) => {
  for (const kind of ["symlink", "directory"]) {
    await t.test(kind, async (t) => {
      const f = fixture(t);
      const { folder } = f.app("widget", 4380);
      fs.writeFileSync(path.join(folder, "package.json"), '{"scripts":{"dev":"rslib mf-dev"}}');
      fs.writeFileSync(path.join(folder, "tsconfig.json"), "{}");
      fs.writeFileSync(path.join(folder, "other.ts"), "export const other = 1;");
      fs.writeFileSync(
        path.join(folder, "rslib.config.ts"),
        `export default { lib: [{ format: 'mf', plugins: [pluginModuleFederation({
          name: 'widget', exposes: { '.': process.env.FIXTURE_ENTRY ?? './index.ts' }
        })] }] };`,
      );
      const envFile = path.join(folder, ".env");
      if (kind === "symlink") {
        const denied = path.join(path.dirname(folder), "denied.env");
        fs.writeFileSync(denied, "FIXTURE_ENTRY=./outside.ts\n");
        fs.symlinkSync(denied, envFile, "file");
      } else {
        fs.mkdirSync(envFile);
      }
      const app = readAppFolder(folder, "development");
      assert.ok(app?.generateTypes);
      assert.equal(app.launchEnvironment?.env.FIXTURE_ENTRY, undefined);
      const report = await rebuildAllTypes(f.context([app]), {
        ...unused,
        generateLocalFederatedTypes: mockGeneration((appDir) => {
          fs.rmSync(envFile, { recursive: true });
          fs.writeFileSync(envFile, "FIXTURE_ENTRY=./other.ts\n");
          return writeZip(path.join(appDir, "dist", "@mf-types.zip"), "old config");
        }),
      });
      assert.equal(
        readAppFolder(folder, "development")?.launchEnvironment?.env.FIXTURE_ENTRY,
        "./other.ts",
      );
      assert.deepEqual(report.rebuilt, []);
      assert.match(
        report.failed[0]?.reason ?? "",
        /build configuration changed during type generation/,
      );
      assert.equal(f.confirmations.generation(app.name), null);
    });
  }
});

test("Rebuild All notices when a higher-priority config helper becomes available", async (t) => {
  const f = fixture(t);
  const { folder } = f.app("widget", 4380);
  fs.writeFileSync(path.join(folder, "tsconfig.json"), '{"files":["index.ts"]}');
  fs.writeFileSync(path.join(folder, "settings.js"), "export const port = 4380;");
  fs.writeFileSync(
    path.join(folder, "rslib.config.ts"),
    `
    import { port } from "./settings";
    export default {
      server: { port },
      lib: [{ format: "mf", plugins: [pluginModuleFederation({
        name: "widget", exposes: { ".": "./index.ts" }
      })] }]
    };
  `,
  );
  const app = readAppFolder(folder, "development");
  assert.equal(app?.port, 4380);
  const report = await rebuildAllTypes(f.context([app]), {
    ...unused,
    generateLocalFederatedTypes: mockGeneration((appDir) => {
      fs.writeFileSync(path.join(folder, "settings.ts"), "export const port = 4381;");
      return writeZip(path.join(appDir, "dist", "@mf-types.zip"), "old config");
    }),
  });
  assert.equal(readAppFolder(folder, "development")?.port, 4381);
  assert.deepEqual(report.rebuilt, []);
  assert.match(
    report.failed[0]?.reason ?? "",
    /build configuration changed during type generation/,
  );
  assert.equal(f.confirmations.generation(app.name), null);
});

test("Rebuild All detects mode dotenv changes even when the dev script disables dotenv", async (t) => {
  const f = fixture(t);
  const { folder } = f.app("widget", 4380);
  fs.writeFileSync(
    path.join(folder, "package.json"),
    '{"scripts":{"dev":"rsbuild dev --env-mode staging --no-env"}}',
  );
  fs.writeFileSync(
    path.join(folder, "rsbuild.config.ts"),
    `
    export default { plugins: [pluginModuleFederation({
      name: 'widget', exposes: { '.': './index.ts' }, dts: true
    })] };
  `,
  );
  const envFile = path.join(folder, ".env.staging.local");
  fs.writeFileSync(envFile, "FIXTURE_DTS_MODE=first");
  const app = readAppFolder(folder, "development");
  assert.equal(app?.launchEnvironment?.envMode, "staging");
  assert.equal(app.launchEnvironment.env.FIXTURE_DTS_MODE, undefined);
  const customZip = path.join(folder, "build", "@mf-types.zip");
  const report = await rebuildAllTypes(
    f.context([app], { rebuildCommand: "npm run build-types", zipPathOverride: () => customZip }),
    {
      ...unused,
      generateLocalFederatedTypes,
      async runRebuildCommand() {
        fs.writeFileSync(envFile, "FIXTURE_DTS_MODE=second");
        writeZip(customZip, "old config");
      },
    },
  );
  assert.deepEqual(report.rebuilt, []);
  assert.match(
    report.failed[0]?.reason ?? "",
    /build configuration changed during type generation/,
  );
  assert.equal(f.confirmations.generation(app.name), null);
});

test("Rebuild All detects a package boundary changing how a config helper resolves", async (t) => {
  const f = fixture(t);
  const { folder } = f.app("widget", 4380);
  fs.writeFileSync(path.join(folder, "package.json"), "{}");
  fs.writeFileSync(path.join(folder, "tsconfig.json"), '{"files":["index.ts"]}');
  fs.writeFileSync(path.join(folder, "settings.ts"), "export const port = 4380;");
  fs.mkdirSync(path.join(folder, "config"));
  fs.writeFileSync(path.join(folder, "config", "helper.ts"), 'export { port } from "../settings";');
  fs.writeFileSync(
    path.join(folder, "rslib.config.ts"),
    `
    import { port } from "./config/helper";
    export default {
      server: { port },
      lib: [{ format: "mf", plugins: [pluginModuleFederation({
        name: "widget", exposes: { ".": "./index.ts" }
      })] }]
    };
  `,
  );
  const app = readAppFolder(folder, "development");
  assert.equal(app?.port, 4380);
  const report = await rebuildAllTypes(f.context([app]), {
    ...unused,
    generateLocalFederatedTypes: mockGeneration((appDir) => {
      fs.writeFileSync(path.join(folder, "config", "package.json"), "{}");
      return writeZip(path.join(appDir, "dist", "@mf-types.zip"), "old config");
    }),
  });
  assert.equal(readAppFolder(folder, "development")?.port, 3000);
  assert.deepEqual(report.rebuilt, []);
  assert.match(
    report.failed[0]?.reason ?? "",
    /build configuration changed during type generation/,
  );
  assert.equal(f.confirmations.generation(app.name), null);
});

test("Rebuild All hashes only bounded config inputs admitted by Discover", (t) => {
  const f = fixture(t);
  const { folder: launcher } = f.app("launcher", 8999);
  const { folder: project } = f.app("library", 9000);
  fs.writeFileSync(
    path.join(launcher, "package.json"),
    '{"scripts":{"dev":"rslib mf-dev --root ../library --config ../launcher/custom.ts"}}',
  );
  fs.writeFileSync(path.join(project, "package.json"), "{}");
  const deniedEnv = path.join(project, ".env.local");
  const deniedImport = path.join(project, "data.json");
  const allowedEnv = path.join(launcher, ".env.local");
  fs.writeFileSync(deniedEnv, "PORT=9000");
  fs.writeFileSync(allowedEnv, "PORT=8000");
  fs.writeFileSync(deniedImport, '{"entry":"https://example.test/manifest.json"}');
  const helperDir = path.join(launcher, "helpers");
  const helper = path.join(helperDir, "routes.ts");
  fs.mkdirSync(helperDir);
  fs.writeFileSync(helper, 'export const route = "https://example.test/mf-manifest.json"');
  const config = path.join(launcher, "custom.ts");
  fs.writeFileSync(
    config,
    `import dotenv from 'dotenv';
     import fs from 'node:fs';
     import path from 'node:path';
     import { route } from './helpers/routes';
     import data from '../library/data.json';
     const local = dotenv.parse(fs.readFileSync(path.join(__dirname, '.env.local'), 'utf8'));
     export default { server: { port: local.PORT },
       lib:[{format:'mf',plugins:[pluginModuleFederation({
         name:'library', remotes: { local: route, denied: data.entry }
       })]}] };`,
  );
  const app = loadKnownApps(
    [{ name: "root", path: path.dirname(project) }],
    { library: { path: "launcher" } },
    "development",
  )[0];
  assert.equal(app?.folder, project);
  assert.equal(app.port, 8000);
  assert.ok(app.configDependencies?.includes(deniedImport));
  assert.deepEqual(
    app.remotes.map(({ url }) => url),
    ["https://example.test/mf-manifest.json", null],
  );
  const context = f.context([app]);
  const fingerprint = () => inputsFingerprint(app, context, null, "tsconfig", []);
  const original = fingerprint();
  fs.writeFileSync(deniedEnv, "PORT=9001");
  fs.writeFileSync(deniedImport, "{}");
  const open = t.mock.method(fs, "openSync");
  const opened = () => open.mock.calls.map(({ arguments: [file] }) => String(file));
  const canonical = (file: string) =>
    path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
  assert.equal(fingerprint(), original);
  assert.ok(
    !opened().some((file) => file === canonical(deniedEnv) || file === canonical(deniedImport)),
  );
  assert.ok(app.configInputs?.some(({ file }) => file === allowedEnv));

  fs.writeFileSync(allowedEnv, "PORT=8001");
  assert.notEqual(fingerprint(), original);
  fs.writeFileSync(allowedEnv, "PORT=8000");
  fs.appendFileSync(config, "\n// changed");
  const changed = fingerprint();
  assert.notEqual(changed, original);

  const originalHelper = canonical(helper);
  fs.renameSync(helperDir, path.join(launcher, "original-helpers"));
  const outsideHelper = path.join(project, "routes.ts");
  fs.writeFileSync(outsideHelper, "export const route = 'private'");
  fs.symlinkSync(project, helperDir, "dir");
  open.mock.resetCalls();
  assert.notEqual(fingerprint(), changed);
  assert.ok(!opened().includes(originalHelper) && !opened().includes(canonical(outsideHelper)));
});

test("built-in Rslib DTS honors the Discover package boundary for dotenv", async (t) => {
  const f = fixture(t);
  const { folder: launcher } = f.app("launcher", 8999);
  const { folder } = f.app("widget", 9000);
  const workspaceRoot = path.dirname(folder);
  fs.writeFileSync(
    path.join(launcher, "package.json"),
    '{"scripts":{"dev":"rslib mf-dev --root ../widget"}}',
  );
  fs.writeFileSync(path.join(folder, "package.json"), "{}");
  fs.writeFileSync(path.join(folder, "tsconfig.json"), "{}");
  const dotenv = path.join(folder, ".env.local");
  fs.writeFileSync(dotenv, "FIXTURE_ENTRY=./index.ts\n");
  const configFile = path.join(folder, "rslib.config.ts");
  fs.writeFileSync(
    configFile,
    `import * as dotenv from 'dotenv';
     import * as fs from 'node:fs';
     import * as path from 'node:path';
     const local = dotenv.parse(fs.readFileSync(path.join(__dirname,'.env.local'), 'utf8'));
     export default { lib:[{format:'mf',plugins:[pluginModuleFederation({
       name:'widget', exposes:{'.':local.FIXTURE_ENTRY},
       dts:{generateTypes:true,consumeTypes:false},
     })]}] };`,
  );
  installGeneratorFixture(
    folder,
    `
if (dtsManagerOptions.remote.moduleFederationConfig.exposes['.'] !== './index.ts') {
  throw new Error('unexpected exposed entry');
}
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/@mf-types.zip', Buffer.from([0x50, 0x4b, 3, 4, 1]));
    `,
  );
  const discovered = loadKnownApps(
    [{ name: "root", path: workspaceRoot }],
    { widget: { path: "launcher" } },
    "development",
  )[0];
  assert.equal(discovered?.launchFolder, launcher);
  assert.equal(discovered.launchEnvironment?.allowLocalEnv, false);
  const context = f.context([discovered]);
  const fingerprint = await inputsFingerprint(discovered, context, null, "tsconfig", []);
  fs.writeFileSync(dotenv, "FIXTURE_ENTRY=./another.ts\n");
  assert.equal(await inputsFingerprint(discovered, context, null, "tsconfig", []), fingerprint);
  fs.writeFileSync(dotenv, "FIXTURE_ENTRY=./index.ts\n");

  const runAll = (app: LocalApp) =>
    rebuildAllTypes(f.context([app]), { ...unused, generateLocalFederatedTypes });
  const rejected = /Could not resolve Module Federation\.exposes\.\. statically/;
  const report = await runAll(discovered);
  assert.deepEqual(report.rebuilt, []);
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0].reason, rejected);
  t.mock.method(globalThis, "fetch", unused.installRemoteTypes);
  await assert.rejects(
    rebuildTypes(discovered.name, {
      apps: [discovered],
      book: createProbeBook(),
      confirmations: f.confirmations,
      published: new Map(),
      settings: {
        "mf-dashboard.scripts.start": "dev",
        rebuildCommand: "",
        envMode: "development",
      },
      refetchCommand: () => "",
      persist() {},
      rebuilt: () => assert.fail("denied dotenv must not produce a declaration archive"),
    }),
    rejected,
  );
  const zip = path.join(folder, "dist", "@mf-types.zip");
  assert.equal(fs.existsSync(zip), false);

  const local = readAppFolder(folder, "development");
  assert.ok(local);
  const allowed = await runAll(local);
  assert.deepEqual(allowed.failed, []);
  assert.deepEqual(allowed.rebuilt, ["widget"]);
  assert.ok(fs.existsSync(zip));
});

test("built-in Rslib DTS rejects a config directory rebound after Discover", async (t) => {
  const f = fixture(t);
  const { folder } = f.app("library", 9000);
  const configDir = path.join(folder, "config");
  const replacement = path.join(path.dirname(folder), "replacement");
  fs.writeFileSync(
    path.join(folder, "package.json"),
    '{"scripts":{"dev":"rslib mf-dev --config config/rslib.config.ts"}}',
  );
  fs.writeFileSync(path.join(folder, "tsconfig.json"), "{}");
  const config = `import * as dotenv from 'dotenv';
    import * as fs from 'node:fs';
    import * as path from 'node:path';
    const local = dotenv.parse(fs.readFileSync(path.join(__dirname,'.env.local'), 'utf8'));
    export default { lib:[{format:'mf',plugins:[pluginModuleFederation({
      name:'library', exposes:{'.':local.FIXTURE_ENTRY},
      dts:{generateTypes:true,consumeTypes:false},
    })]}] };`;
  for (const dir of [configDir, replacement]) {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "rslib.config.ts"), config);
    fs.writeFileSync(path.join(dir, ".env.local"), "FIXTURE_ENTRY=./index.ts\n");
  }
  fs.writeFileSync(path.join(replacement, "package.json"), "{}");
  installGeneratorFixture(
    folder,
    `fs.mkdirSync('dist', { recursive: true });
     fs.writeFileSync('dist/@mf-types.zip', Buffer.from([0x50, 0x4b, 3, 4, 1]));`,
  );
  const app = readAppFolder(folder, "development");
  assert.ok(app);
  const run = () => rebuildAllTypes(f.context([app]), { ...unused, generateLocalFederatedTypes });
  const before = await run();
  assert.deepEqual(before.failed, []);
  assert.deepEqual(before.rebuilt, ["library"]);

  fs.renameSync(configDir, path.join(folder, "previous-config"));
  fs.symlinkSync(replacement, configDir, "dir");
  const after = await run();
  assert.deepEqual(after.rebuilt, []);
  assert.equal(after.failed.length, 1);
  assert.match(after.failed[0].reason, /Could not resolve the Rslib MF profile/);
});

test("Rslib generates local declarations with unresolved remotes when extraction is off", async (t) => {
  const f = fixture(t);
  const { folder } = f.app("designKit", 9000);
  const configFile = path.join(folder, "rslib.config.ts");
  const writeConfig = (extract: boolean, origin = "process.env.HOST_ORIGIN") =>
    fs.writeFileSync(
      configFile,
      `export default { lib: [{ format: 'mf', plugins: [pluginModuleFederation({
      name: 'designKit', exposes: { '.': './index.ts' },
      remotes: { host: \`host@\${${origin}}/mf-manifest.json\` },
      dts: { generateTypes: { extractRemoteTypes: ${extract} } },
    })] }] };`,
    );
  installGeneratorFixture(
    folder,
    `
const { extractRemoteTypes, moduleFederationConfig: { remotes } } = dtsManagerOptions.remote;
if (extractRemoteTypes ? remotes.host !== "host@http://localhost:9001/mf-manifest.json" : remotes !== undefined) {
  throw new Error("unexpected remotes passed to DTS");
}
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/@mf-types.zip", Buffer.from([0x50, 0x4b, 3, 4, ...Buffer.from(String(extractRemoteTypes))]));
  `,
  );
  const generate = () =>
    generateLocalFederatedTypes({
      appDir: folder,
      configFile,
      name: "designKit",
      bundler: "rslib",
      envMode: "development",
      env: {},
      workspaceFingerprint: "workspace",
    });
  writeConfig(false);
  assert.equal(readAppFolder(folder, "development")?.remotes[0]?.url, null);
  assert.ok(fs.existsSync((await generate()).zipPath));
  writeConfig(true);
  await assert.rejects(generate(), /Could not resolve Module Federation\.remotes\.host statically/);
  writeConfig(true, JSON.stringify("http://localhost:9001"));
  assert.ok(fs.existsSync((await generate()).zipPath));
});

test("Rslib DTS bounds shared objects and repeated text before calling the SDK", async (t) => {
  const { folder } = fixture(t).app("widget", 9000);
  const configFile = path.join(folder, "rslib.config.ts");
  const writeConfig = (bindings: string, payload: string, expose = "'./index.ts'") =>
    fs.writeFileSync(
      configFile,
      `export default ((${bindings}) => ({ lib: [{ format: 'mf', plugins: [pluginModuleFederation({
        name: 'widget', exposes: { '.': ${expose} },
        dts: { generateTypes: true, extraOptions: { payload: ${payload} } },
      })] }] }))();`,
    );
  installGeneratorFixture(
    folder,
    `
const payload = dtsManagerOptions.remote.moduleFederationConfig.dts.extraOptions.payload;
if (JSON.stringify(payload) !== '["leaf","leaf"]') throw new Error('unexpected DTS payload');
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/@mf-types.zip", Buffer.from([0x50, 0x4b, 3, 4, 1]));
`,
  );
  const generate = () =>
    generateLocalFederatedTypes({
      appDir: folder,
      configFile,
      name: "widget",
      bundler: "rslib",
      envMode: "development",
      env: {},
      workspaceFingerprint: "workspace",
    });
  const nested = Array.from({ length: 15 }, (_, i) => `p${i + 1}={a:p${i},b:p${i}}`);
  writeConfig(["p0={}", ...nested].join(","), "p15");
  const limit =
    /Static Module Federation options exceed the DTS conversion limit.*Set mf-dashboard\.commands\.rebuildTypes/;
  await assert.rejects(generate(), limit);

  writeConfig(
    `text=${JSON.stringify("x".repeat(32 * 1024))}`,
    `[${Array(33).fill("text").join(",")}]`,
  );
  await assert.rejects(generate(), limit);

  writeConfig(
    `text='leaf', query=${JSON.stringify("x".repeat(65 * 1024))}`,
    "[text,text]",
    "'./index.ts?' + query",
  );
  await assert.rejects(generate(), /Could not resolve Module Federation\.exposes statically/);

  writeConfig("text='leaf'", "[text,text]");
  assert.ok(fs.existsSync((await generate()).zipPath));
});

test("Rslib rebuild uses an explicit DTS output even when the bundler output is unresolved", async (t) => {
  const f = fixture(t);
  const { folder } = f.app("designKit", 9000);
  const configFile = path.join(folder, "rslib.config.ts");
  const writeConfig = (generateTypes: boolean | { outputDir: string }) =>
    fs.writeFileSync(
      configFile,
      `import { resolve } from 'node:path';
      export default {
        output: { distPath: { root: resolve('dist', 'js') } },
        lib: [{ format: 'mf', plugins: [pluginModuleFederation({
          name: 'designKit', exposes: { '.': './index.ts' },
          dts: { generateTypes: ${JSON.stringify(generateTypes)} },
        })] }],
      };`,
    );
  installGeneratorFixture(
    folder,
    `
const outputDir = dtsManagerOptions.remote.outputDir;
if (outputDir !== 'artifacts') throw new Error('unexpected DTS output');
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputDir + '/@mf-types.zip', Buffer.from([0x50, 0x4b, 3, 4, 1]));
`,
  );
  const generate = () =>
    generateLocalFederatedTypes({
      appDir: folder,
      configFile,
      name: "designKit",
      bundler: "rslib",
      envMode: "development",
      env: {},
      workspaceFingerprint: "workspace",
    });
  writeConfig({ outputDir: "artifacts" });
  const zipPath = path.join(folder, "artifacts", "@mf-types.zip");
  assert.equal(readAppFolder(folder, "development")?.generatedZipPath, zipPath);
  assert.equal((await generate()).zipPath, zipPath);
  assert.ok(fs.existsSync(zipPath));
  writeConfig(true);
  await assert.rejects(generate(), /Could not resolve output\.distPath/);
});

test("an inactive Rslib profile does not publish its federation helper as an app", (t) => {
  const f = fixture(t);
  const { folder } = f.app("designKit", 9000);
  fs.writeFileSync(
    path.join(folder, "module-federation.config.ts"),
    `export default { name: "designKit", dts: true, exposes: { ".": "./index.ts" } };`,
  );
  fs.writeFileSync(
    path.join(folder, "rslib.config.ts"),
    `
import { defineConfig } from "@rslib/core";
import { pluginModuleFederation } from "@module-federation/rsbuild-plugin";
import federation from "./module-federation.config";
export default defineConfig({ lib: process.env.NODE_ENV === "production"
  ? [{ format: "esm" }]
  : [{ format: "mf", plugins: [pluginModuleFederation(federation)] }]
});`,
  );
  const pkg = path.join(folder, "package.json");
  fs.writeFileSync(pkg, JSON.stringify({ scripts: { dev: "rslib mf-dev" } }));
  assert.equal(readAppFolder(folder, "development")?.name, "designKit");
  fs.writeFileSync(
    pkg,
    JSON.stringify({ scripts: { dev: "cross-env NODE_ENV=production rslib mf-dev" } }),
  );
  assert.equal(readAppFolder(folder, "development"), null);
  assert.equal(
    readAppFolder(folder, "development", undefined, undefined, undefined, "dev", "rslib.config.ts"),
    null,
  );
  assert.deepEqual(Object.keys(scanWorkspace(folder)), []);
});

test("an explicitly selected Rslib factory receives the dev command and env mode", (t) => {
  const f = fixture(t);
  const { folder } = f.app("designKit", 9000);
  fs.writeFileSync(
    path.join(folder, "custom.config.ts"),
    `
import { defineConfig } from "@rslib/core";
import { pluginModuleFederation } from "@module-federation/rsbuild-plugin";
export default defineConfig(({ command, envMode }) => ({
  lib: command === "mf-dev" && envMode === "testing" && process.env.NODE_ENV === "development"
    ? [{ format: "mf", plugins: [pluginModuleFederation({ name: "designKit", dts: true })] }]
    : [{ format: "esm" }],
  server: { port: 9000 },
}));`,
  );
  const app = readAppFolder(
    folder,
    "testing",
    "designKit",
    undefined,
    undefined,
    "dev",
    "custom.config.ts",
  );
  assert.equal(app?.name, "designKit");
  assert.equal(app?.port, 9000);
});

test("Rslib reads and tracks env files in priority order and honors --no-env", (t) => {
  const f = fixture(t);
  const { folder } = f.app("designKit", 9000);
  const pkg = path.join(folder, "package.json");
  const writeScript = (dev: string) => fs.writeFileSync(pkg, JSON.stringify({ scripts: { dev } }));
  writeScript("rslib mf-dev --env-mode testing");
  const values = {
    ".env": "MF_NAME=designKit\nBASE_ONLY=base\nPORT=9001\n",
    ".env.local": "LOCAL_ONLY=local\nPORT=9002\n",
    ".env.testing": "PORT=9003\n",
    ".env.testing.local": "PORT=9004\n",
  };
  for (const [name, value] of Object.entries(values))
    fs.writeFileSync(path.join(folder, name), value);
  fs.writeFileSync(
    path.join(folder, "rslib.config.ts"),
    `
import { pluginModuleFederation } from "@module-federation/rsbuild-plugin";
export default {
  lib: [{ format: "mf", plugins: [pluginModuleFederation({ name: process.env.MF_NAME, dts: true })] }],
  server: { port: process.env.PORT },
};`,
  );
  const dependencies = new Set<string>();
  const app = readAppFolder(folder, "development", undefined, dependencies);
  assert.equal(app?.name, "designKit");
  assert.equal(app?.port, 9004);
  assert.equal(app?.launchEnvironment?.env.BASE_ONLY, "base");
  assert.equal(app?.launchEnvironment?.env.LOCAL_ONLY, "local");
  for (const name of Object.keys(values))
    assert.ok(dependencies.has(path.join(folder, name)), name);

  for (const [args, enabled] of [
    ["mf-dev --env-mode testing --no-env", false],
    ["mf-dev --env-mode testing --env=false", false],
    ["mf-dev --env-mode testing --env false", false],
    ["mf-dev --env-mode testing --env=true", true],
    ["mf-dev --env-mode testing --no-env --env=true", true],
    ["mf-dev --env-mode testing --env=true --no-env", false],
    ["mf-dev --env-mode testing --env=false --env=false", true],
    ["mf-dev --env-mode testing -- --env=false", true],
    ["--env-mode testing --env mf-dev", true],
    ["--env-mode testing --env false mf-dev", false],
  ] as const) {
    writeScript(`cross-env MF_NAME=designKit rslib ${args}`);
    const found = readAppFolder(folder, "development");
    assert.equal(found?.name, "designKit", args);
    assert.equal(found?.port, enabled ? 9004 : 3000, args);
    assert.equal(found.launchEnvironment?.env.BASE_ONLY, enabled ? "base" : undefined, args);
  }
});

test("Rslib expands merged dotenv values with the selected launch environment", (t) => {
  const f = fixture(t);
  const { folder } = f.app("designKit", 9000);
  fs.writeFileSync(
    path.join(folder, "package.json"),
    '{"scripts":{"dev":"cross-env PREFIX=remote rslib mf-dev --env-mode review"}}',
  );
  fs.writeFileSync(
    path.join(folder, ".env"),
    [
      "PREFIX=base",
      "SUFFIX=local",
      "MF_NAME=${PREFIX}_$SUFFIX",
      "PORT=${UNSET_PORT:-9002}",
      "ALTERNATE=${PREFIX:+enabled}",
      "LITERAL=\\$PREFIX",
      "LITERAL_COPY=$LITERAL",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(folder, ".env.review"), "SUFFIX=dev\n");
  fs.writeFileSync(
    path.join(folder, "rslib.config.ts"),
    `export default {
    server: { port: process.env.PORT },
    lib: [{ format: 'mf', plugins: [pluginModuleFederation({ name: process.env.MF_NAME })] }],
  };`,
  );
  const { remote_dev: app } = scanWorkspace(folder);
  assert.equal(app?.port, 9002);
  assert.equal(app.launchEnvironment?.env.ALTERNATE, "enabled");
  assert.equal(app.launchEnvironment?.env.LITERAL, "$PREFIX");
  assert.equal(app.launchEnvironment?.env.LITERAL_COPY, "$PREFIX");
  assert.equal(app.launchEnvironment?.env.PREFIX, "remote");
});

test("Rslib uses dotenv NODE_ENV for the profile and its factory mode without --env-mode", (t) => {
  const f = fixture(t);
  const { folder } = f.app("designKit", 9000);
  const pkg = path.join(folder, "package.json");
  fs.writeFileSync(
    pkg,
    '{"scripts":{"dev":"cross-env NODE_ENV=development LABEL=fromLaunch rslib mf-dev"}}',
  );
  fs.writeFileSync(path.join(folder, ".env.development"), "NODE_ENV=production\nLABEL=fromFile\n");
  fs.writeFileSync(path.join(folder, ".env.production"), "NODE_ENV=test\n");
  fs.writeFileSync(
    path.join(folder, "rslib.config.ts"),
    `
    export default defineConfig(({ envMode }) => ({
      lib: [{ format: 'mf', plugins: [pluginModuleFederation({
        name: envMode + '-' + process.env.NODE_ENV + '-' + process.env.LABEL,
      })] }],
    }));`,
  );
  const app = readAppFolder(folder, "dashboard-mode");
  assert.equal(app?.name, "production-production-fromLaunch");
  assert.equal(app.launchEnvironment?.envMode, "production");
});

test("Rslib discovery honors the launch context and defaults DTS on for TypeScript", (t) => {
  const f = fixture(t);
  const { folder } = f.app("designKit", 9000);
  const pkg = path.join(folder, "package.json");
  const script = "cross-env MF_NAME=designKit rslib mf-dev --env-mode testing";
  fs.writeFileSync(pkg, JSON.stringify({ scripts: { dev: script } }));
  fs.writeFileSync(path.join(folder, "tsconfig.json"), "{}");
  fs.writeFileSync(
    path.join(folder, "rslib.config.ts"),
    `
import { defineConfig } from "@rsbuild/core";
import { pluginModuleFederation } from "@module-federation/rsbuild-plugin";
export default defineConfig(({ envMode }) => ({
  lib: envMode === "testing" && process.env.NODE_ENV === "development"
    ? [{ format: "mf", plugins: [pluginModuleFederation({ name: process.env.MF_NAME, exposes: { ".": "./index.ts" } })] }]
    : [{ format: "esm" }],
}));`,
  );
  const read = () =>
    readAppFolder(
      folder,
      "development",
      "designKit",
      undefined,
      undefined,
      "dev",
      "rslib.config.ts",
    );
  const app = read();
  assert.equal(app?.name, "designKit");
  assert.equal(app?.generateTypes, true);
  assert.equal(app?.generatedZipPath, path.join(folder, "dist/@mf-types.zip"));
  assert.equal(app?.launchEnvironment?.env.MF_NAME, "designKit");
  fs.writeFileSync(
    pkg,
    JSON.stringify({
      scripts: { dev: script.replace("cross-env", "cross-env NODE_ENV=production") },
    }),
  );
  assert.equal(read(), null);
});

test("bulk rebuild uses the Rsbuild server route unless a manifest path is configured", async (t) => {
  const f = fixture(t);
  const seed = f.app("fixture-library", 53941);
  const source = `
    import { pluginModuleFederation } from "@module-federation/rsbuild-plugin";
    export default {
      server: { port: ${seed.port}, base: "/dev-fixture/" },
      output: { assetPrefix: import.meta.env.FIXTURE_PUBLIC_PATH },
      plugins: [pluginModuleFederation({ name: "${seed.name}",
        manifest: { fileName: "fixture-manifest.json" },
        exposes: { "./index": "./index.ts" }, dts: { generateTypes: true, consumeTypes: false }
      })]
    };
  `;
  fs.writeFileSync(seed.configFile, source);
  fs.writeFileSync(
    path.join(seed.folder, ".env.development"),
    "FIXTURE_PUBLIC_PATH=/public-fixture/\n",
  );
  const load = (manifestPath?: string) =>
    loadKnownApps(
      [{ name: "fixture-root", path: seed.folder }],
      { [seed.name]: { path: ".", manifestPath } },
      "development",
    )[0];
  const producer = load();
  const expectedPath = "/dev-fixture/fixture-manifest.json";
  assert.equal(producer?.manifestPath, expectedPath);
  const explicitPath = "/public-fixture/fixture-manifest.json";
  assert.equal(load(explicitPath)?.manifestPath, explicitPath);
  const consumer = f.app("fixture-client", 53942, {
    generateTypes: false,
    consumeTypes: true,
    remotes: [{ ...remote(seed), url: `http://localhost:${seed.port}${expectedPath}` }],
  });
  const report = await rebuildAllTypes(f.context([consumer, producer]), {
    ...unused,
    generateLocalFederatedTypes: mockGeneration((appDir) =>
      writeZip(path.join(appDir, "dist", "@mf-types.zip"), "fixture declarations"),
    ),
  });
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.installed, [{ consumer: consumer.name, alias: producer.name }]);

  fs.writeFileSync(seed.configFile, source.replace(', base: "/dev-fixture/"', ""));
  assert.equal(readAppFolder(seed.folder, "development")?.manifestPath, "/fixture-manifest.json");
});

test("bulk rebuild installs types from a local ZIP through the Rsbuild dev asset route", async (t) => {
  const f = fixture(t);
  const seed = f.app("fixture-asset-library", 53951);
  fs.writeFileSync(
    seed.configFile,
    `
    import { pluginModuleFederation } from "@module-federation/rsbuild-plugin";
    export default {
      server: { port: ${seed.port}, base: "/fixture-app/" },
      dev: { assetPrefix: process.env.FIXTURE_DEV_ASSETS },
      output: { assetPrefix: "/published-fixture/" },
      plugins: [pluginModuleFederation({ name: "${seed.name}",
        manifest: { filePath: "metadata", fileName: "entry" },
        exposes: { "./index": "./index.ts" }, dts: { generateTypes: true, consumeTypes: false }
      })]
    };
    `,
  );
  fs.writeFileSync(
    path.join(seed.folder, ".env.development"),
    "FIXTURE_DEV_ASSETS=/fixture-app/assets/\n",
  );
  const [producer] = loadKnownApps(
    [{ name: "fixture-root", path: seed.folder }],
    { [seed.name]: { path: "." } },
    "development",
  );
  assert.ok(producer);
  assert.equal(producer.manifestPath, "/fixture-app/metadata/entry.json");

  const consumer = f.app("fixture-asset-client", 53952, {
    consumeTypes: true,
    remotes: [
      {
        ...remote(seed),
        url: `http://localhost:${seed.port}/fixture-app/assets/metadata/entry.json`,
      },
    ],
  });
  const declaration = 'export declare const source: "offline";';
  const report = await rebuildAllTypes(f.context([consumer, producer]), {
    ...unused,
    generateLocalFederatedTypes: mockGeneration((appDir) => {
      if (appDir === consumer.folder)
        assert.equal(fs.readFileSync(typeFile(consumer, producer.name), "utf8"), declaration);
      return writeZip(path.join(appDir, "dist", "@mf-types.zip"), declaration);
    }),
  });
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.rebuilt, [producer.name, consumer.name]);
  assert.deepEqual(report.installed, [{ consumer: consumer.name, alias: producer.name }]);
});

test("offline workspace rebuild installs dependencies before generation and visits a shared producer once", async (t) => {
  const f = fixture(t);
  const leaf = f.app("leaf", 4501);
  const leafAlias = "@fixture/leaf";
  const middle = f.app("middle", 4502, { consumeTypes: true, remotes: [remote(leaf, leafAlias)] });
  const shell = f.app("a-shell", 4503, {
    hasExposes: false,
    consumeTypes: true,
    remotes: [remote(middle)],
  });
  const editor = f.app("editor", 4504, {
    generateTypes: false,
    consumeTypes: true,
    remotes: [remote(leaf, "shared")],
  });
  fs.writeFileSync(path.join(leaf.folder, "tsconfig.json"), '{"extends":"./tsconfig.base.json"}');
  const inherited = path.join(leaf.folder, "tsconfig.base.json");
  fs.writeFileSync(inherited, '{"compilerOptions":{"strict":false}}');
  const calls: string[] = [];
  const io = {
    ...unused,
    generateLocalFederatedTypes: mockGeneration((appDir) => {
      const name = path.basename(appDir);
      calls.push(name);
      const input = name === "middle" ? fs.readFileSync(typeFile(middle, leafAlias), "utf8") : "";
      const source = fs.readFileSync(path.join(appDir, "index.ts"), "utf8");
      return writeZip(path.join(appDir, "dist", "@mf-types.zip"), `${source}${input}`);
    }),
  };
  const context = f.context([editor, middle, shell, leaf]);
  const first = await rebuildAllTypes(context, io);
  assert.deepEqual(first.failed, []);
  assert.deepEqual(first.skipped, []);
  assert.deepEqual(first.rebuilt, ["leaf", "middle"]);
  assert.deepEqual(calls, ["leaf", "middle"]);
  assert.equal(first.installed.length, 3);
  assert.equal(fs.readFileSync(typeFile(shell, "middle"), "utf8"), "middleleaf");
  assert.equal(fs.readFileSync(typeFile(editor, "shared"), "utf8"), "leaf");

  const persisted = createConfirmationStore(f.confirmations.snapshot());
  const second = await rebuildAllTypes({ ...context, confirmations: persisted }, io);
  assert.deepEqual(second.current, ["leaf", "middle"]);
  assert.deepEqual(second.installed, []);
  assert.deepEqual(calls, ["leaf", "middle"]);

  fs.rmSync(path.dirname(typeFile(shell, "middle")), { recursive: true });
  const repaired = await rebuildAllTypes({ ...context, confirmations: persisted }, io);
  assert.deepEqual(repaired.rebuilt, []);
  assert.deepEqual(repaired.installed, [{ consumer: "a-shell", alias: "middle" }]);
  assert.equal(fs.readFileSync(typeFile(shell, "middle"), "utf8"), "middleleaf");

  fs.writeFileSync(path.join(leaf.folder, "index.ts"), "changed leaf");
  const changed = await rebuildAllTypes({ ...context, confirmations: persisted }, io);
  assert.deepEqual(changed.rebuilt, ["leaf", "middle"]);
  assert.equal(fs.readFileSync(typeFile(shell, "middle"), "utf8"), "middlechanged leaf");

  fs.writeFileSync(inherited, '{"compilerOptions":{"strict":true}}');
  const reconfigured = await rebuildAllTypes({ ...context, confirmations: persisted }, io);
  assert.deepEqual(reconfigured.rebuilt, ["leaf"]);
  assert.deepEqual(reconfigured.current, ["middle"]);
  assert.deepEqual(reconfigured.installed, []);
});

test("parallel generation checks SDK output paths and requires exclusive access for hooks", async (t) => {
  const f = fixture(t);
  const { name, folder } = f.app("fixture-app", 4501);
  const configFile = path.join(folder, "rsbuild.config.cjs");
  const tempConfigDir = path.join(folder, "node_modules/.federation");
  const shared = path.join(path.dirname(folder), "shared-output");
  fs.mkdirSync(shared);
  fs.writeFileSync(path.join(folder, "tsconfig.json"), "{}");
  fs.writeFileSync(
    configFile,
    `const { pluginModuleFederation } = require("@module-federation/rsbuild-plugin");
module.exports = { plugins: [pluginModuleFederation({
  name: ${JSON.stringify(name)}, exposes: { "./index": "./index.ts" },
  dts: { generateTypes: { generateAPITypes: true, afterGenerate: process.env.FIXTURE_BUILD_HOOK ? () => {} : undefined } }
})] };`,
  );
  installGeneratorFixture(
    folder,
    `fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/@mf-types.zip", Buffer.from([0x50, 0x4b, 3, 4, 0x41]));`,
  );
  fs.appendFileSync(
    path.join(folder, "node_modules/@module-federation/dts-plugin/core.js"),
    `
const readConfig = exports.retrieveRemoteConfig;
exports.retrieveRemoteConfig = options => {
  const config = readConfig(options);
  config.tsConfig.compilerOptions = {
    rootDir: options.context,
    outDir: path.join(options.context, "dist/@mf-types/compiled-types"),
    incremental: true,
    tsBuildInfoFile: options.moduleFederationConfig.name === "implicit" ? null : "./fixture.tsbuildinfo"
  };
  return { ...config, remoteOptions: options };
};
exports.retrieveMfTypesPath = (_config, options) => path.join(options.context, "dist/@mf-types");
exports.retrieveTypesAssetsInfo = options => ({
  apiTypesPath: path.join(options.context, "dist/@mf-types.d.ts"),
  zipTypesPath: path.join(options.context, "dist/@mf-types.zip")
});`,
  );
  const remote = {
    context: folder,
    generateAPITypes: true,
    moduleFederationConfig: { exposes: { "./index": "./index.ts" } },
  };
  const compiler = await listCompilerInputs(createRequire(configFile), remote, folder, undefined);
  const outputs = await compiler?.writePaths?.();
  assert.ok(outputs?.paths.includes(path.join(tempConfigDir, "fixture.tsbuildinfo")));

  const input = {
    appDir: folder,
    name,
    configFile,
    envMode: "development",
    workspaceFingerprint: "fixture",
    parallel: true,
  };
  const needsExclusive = (error: unknown) =>
    error instanceof DiagnosticError && error.details.reason === "parallel-output";
  assert.equal((await generateLocalFederatedTypes(input)).current, false);
  await assert.rejects(
    generateLocalFederatedTypes({ ...input, env: { FIXTURE_BUILD_HOOK: "1" } }),
    needsExclusive,
  );

  const api = path.join(folder, "dist/@mf-types.d.ts");
  const sharedApi = path.join(shared, "api.d.ts");
  fs.writeFileSync(sharedApi, "export {};\n");
  fs.symlinkSync(sharedApi, api, "file");
  await assert.rejects(generateLocalFederatedTypes(input), needsExclusive);
  fs.unlinkSync(api);

  const types = path.join(folder, "dist/@mf-types");
  const nested = path.join(types, "compiled-types");
  fs.mkdirSync(nested, { recursive: true });
  const declaration = path.join(nested, "existing.d.ts");
  fs.symlinkSync(sharedApi, declaration, "file");
  await assert.rejects(generateLocalFederatedTypes(input), needsExclusive);
  fs.unlinkSync(declaration);

  const config = path.join(folder, "tsconfig.json");
  fs.writeFileSync(
    path.join(shared, "base.json"),
    JSON.stringify({ compilerOptions: { module: "amd", outFile: "./shared.js" } }),
  );
  fs.writeFileSync(config, JSON.stringify({ extends: "../shared-output/base.json" }));
  const compilerPackage = path.join(folder, "node_modules/typescript/package.json");
  const originalCompiler = fs.readFileSync(compilerPackage);
  const fakeTsc = path.join(path.dirname(compilerPackage), "tsc.cjs");
  const shownConfig = JSON.stringify({
    compilerOptions: { outDir: nested, outFile: path.join(shared, "shared.js") },
  });
  // Model the TypeScript versions that accept outFile and report it in the effective config.
  fs.writeFileSync(
    fakeTsc,
    `console.log(process.argv.includes("--showConfig") ? ${JSON.stringify(shownConfig)} : ${JSON.stringify(path.join(folder, "index.ts"))});`,
  );
  fs.writeFileSync(compilerPackage, JSON.stringify({ bin: { tsc: fakeTsc } }));
  const inherited = await listCompilerInputs(createRequire(configFile), remote, folder, undefined);
  assert.ok(inherited?.writePaths);
  await assert.rejects(inherited.writePaths(), /Compiler write paths unavailable/);
  await assert.rejects(generateLocalFederatedTypes(input), needsExclusive);
  const implicitConfig = JSON.stringify({
    compilerOptions: { outDir: nested, incremental: true, tsBuildInfoFile: "./" },
  });
  fs.writeFileSync(
    fakeTsc,
    `console.log(process.argv.includes("--showConfig") ? ${JSON.stringify(implicitConfig)} : ${JSON.stringify(path.join(folder, "index.ts"))});`,
  );
  const implicitRemote = {
    ...remote,
    moduleFederationConfig: { ...remote.moduleFederationConfig, name: "implicit" },
  };
  const implicit = await listCompilerInputs(
    createRequire(configFile),
    implicitRemote,
    folder,
    undefined,
  );
  assert.ok(implicit?.writePaths);
  await assert.rejects(implicit.writePaths(), /Compiler build-info path unavailable/);
  fs.writeFileSync(compilerPackage, originalCompiler);
  fs.writeFileSync(config, "{}");

  fs.rmdirSync(tempConfigDir);
  fs.symlinkSync(shared, tempConfigDir, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(generateLocalFederatedTypes(input), needsExclusive);
});

test("a generator with unverified output retries exclusively", async (t) => {
  const f = fixture(t);
  const apps = [f.app("a", 4501), f.app("b", 4502), f.app("c", 4503)];
  const attempts: string[] = [];
  const progress: number[] = [];
  let active = 0;
  const context = f.context(apps, {
    buildConcurrency: 2,
    progress: (_, index) => progress.push(index),
  });
  const result = await rebuildAllTypes(context, {
    ...unused,
    async generateLocalFederatedTypes(input) {
      const { name, appDir, parallel } = input;
      attempts.push(`${name}:${!!parallel}`);
      if (name === "a" && parallel)
        throw new DiagnosticError("needs exclusive output", {
          stage: "generation",
          reason: "parallel-output",
        });
      if (!parallel) assert.equal(active, 0);
      active++;
      try {
        await delay(10);
        return await mockGeneration(() => writeZip(path.join(appDir, "dist/@mf-types.zip"), name))(
          input,
        );
      } finally {
        active--;
      }
    },
  });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.rebuilt.sort(), ["a", "b", "c"]);
  assert.deepEqual(progress, [0, 1, 2]);
  assert.deepEqual(
    attempts.filter((name) => name.startsWith("a:")),
    ["a:true", "a:false"],
  );
});

test("disabling the build cache regenerates archives and records them for subsequent reuse", async (t) => {
  const initialBuild = Date.UTC(2025, 0, 5, 10, 0);
  const forcedBuild = Date.UTC(2025, 0, 6, 11, 0);
  let now = initialBuild;
  t.mock.method(Date, "now", () => now);
  const f = fixture(t);
  const first = f.app("first", 4501);
  const second = f.app("second", 4502);
  const viewer = f.app("viewer", 4503, {
    generateTypes: false,
    consumeTypes: true,
    remotes: [remote(first)],
  });
  const statuses = new Map<string, RebuildAppStatus>();
  const context = f.context([viewer, first, second], {
    buildConcurrency: 2,
    status(updates) {
      for (const update of updates) statuses.set(update.app, update);
    },
  });
  const generators = [first.name, second.name];
  const io = {
    ...unused,
    generateLocalFederatedTypes: mockGeneration((appDir) =>
      writeZip(path.join(appDir, "dist/@mf-types.zip"), path.basename(appDir)),
    ),
  };
  assert.deepEqual((await rebuildAllTypes(context, io)).rebuilt.sort(), generators);
  assert.equal(statuses.get(viewer.name)?.status, "installed");
  assert.equal(statuses.get(first.name)?.builtAt, initialBuild);
  const resumed = {
    ...context,
    confirmations: createConfirmationStore(f.confirmations.snapshot()),
  };
  now = forcedBuild;
  assert.deepEqual((await rebuildAllTypes(resumed, io)).current.sort(), generators);
  assert.deepEqual(
    new Map([...statuses].map(([app, { status }]) => [app, status])),
    new Map([
      [first.name, "cached"],
      [second.name, "cached"],
      [viewer.name, "current"],
    ]),
  );
  assert.equal(statuses.get(first.name)?.builtAt, initialBuild);
  assert.equal(statuses.get(viewer.name)?.builtAt, undefined);
  const uncached = await rebuildAllTypes({ ...resumed, useBuildCache: false }, io);
  assert.deepEqual(uncached.rebuilt.sort(), generators);
  assert.deepEqual(uncached.current, []);
  assert.equal(statuses.get(first.name)?.builtAt, forcedBuild);
  assert.deepEqual((await rebuildAllTypes(resumed, io)).current.sort(), generators);
  assert.equal(statuses.get(first.name)?.builtAt, forcedBuild);
});

test("changing ZIP metadata keeps a dependent's cache and updates its archive confirmation", async (t) => {
  const f = fixture(t);
  const shared = f.app("shared", 4501);
  const consumer = f.app("consumer", 4502, { consumeTypes: true, remotes: [remote(shared)] });
  fs.writeFileSync(
    path.join(path.dirname(shared.folder), "node_modules/adm-zip/index.js"),
    `
    const fs = require("node:fs"), path = require("node:path");
    module.exports = class {
      constructor(bytes) {
        const start = 30 + bytes.readUInt16LE(26);
        this.content = bytes.subarray(start, start + bytes.readUInt32LE(18));
      }
      getEntries() { return [{ entryName: "index.d.ts", isDirectory: false }]; }
      extractAllTo(dir) { fs.writeFileSync(path.join(dir, "index.d.ts"), this.content); }
    };
  `,
  );
  const context = f.context([shared, consumer], { buildConcurrency: 2 });
  let stamp = 0;
  const io = {
    ...unused,
    generateLocalFederatedTypes: (input: LocalGenerationInput) =>
      rebuildLocalArchive(
        input,
        path.join(input.appDir, "dist/@mf-types.zip"),
        { config: "", files: [] },
        async () => {
          const zipPath = path.join(input.appDir, "dist/@mf-types.zip");
          const bytes = zipFixture([
            { file: "index.d.ts", text: "export declare const value: string;" },
          ]);
          bytes.writeUInt16LE(++stamp, 10);
          fs.mkdirSync(path.dirname(zipPath), { recursive: true });
          fs.writeFileSync(zipPath, bytes);
          return { zipPath, zipHash: createHash("sha256").update(bytes).digest("hex") };
        },
      ),
  };
  assert.deepEqual((await rebuildAllTypes(context, io)).rebuilt, ["shared", "consumer"]);
  const consumerBuiltAt = f.confirmations.generation("consumer")?.builtAt;
  assert.equal(typeof consumerBuiltAt, "number");
  const before = f.confirmations.generation("shared")?.zipHash;
  assert.deepEqual((await rebuildAllTypes({ ...context, target: "shared" }, io)).rebuilt, [
    "shared",
  ]);
  const after = f.confirmations.generation("shared")?.zipHash;
  assert.notEqual(before, after);
  const again = await rebuildAllTypes(context, io);
  assert.deepEqual(again.rebuilt, []);
  assert.deepEqual(again.current, ["shared", "consumer"]);
  assert.deepEqual(again.installed, []);
  assert.equal(f.confirmations.generation("consumer")?.builtDependencyHashes.shared, after);
  assert.equal(f.confirmations.generation("consumer")?.builtAt, consumerBuiltAt);
});

test("rebuilding one app forces its generation and reuses only its required local dependencies", async (t) => {
  const f = fixture(t);
  const leaf = f.app("leaf", 4501);
  const selected = f.app("selected", 4502, { consumeTypes: true, remotes: [remote(leaf)] });
  const shell = f.app("shell", 4503, { consumeTypes: true, remotes: [remote(selected)] });
  const other = f.app("other", 4504);
  const updates = new Set<string>();
  const context = f.context([shell, selected, other, leaf], {
    target: selected.name,
    status: (rows) => rows.forEach(({ app }) => updates.add(app)),
  });
  const generated: string[] = [];
  const io = {
    ...unused,
    generateLocalFederatedTypes: mockGeneration((folder) => {
      generated.push(path.basename(folder));
      return writeZip(path.join(folder, "dist", "@mf-types.zip"), "types");
    }),
  };
  const first = await rebuildAllTypes(context, io);
  assert.deepEqual(first.rebuilt, ["leaf", "selected"]);
  assert.deepEqual(first.installed, [{ consumer: "selected", alias: "leaf" }]);
  const second = await rebuildAllTypes(context, io);
  assert.deepEqual(second.current, ["leaf"]);
  assert.deepEqual(second.rebuilt, ["selected"]);
  assert.deepEqual(generated, ["leaf", "selected", "selected"]);
  assert.deepEqual(updates, new Set(["leaf", "selected"]));
  assert.equal(fs.existsSync(typeFile(shell, "selected")), false);
});

test("cycles, unresolved remotes and failed producers block only dependent chains", async (t) => {
  const f = fixture(t);
  const a = f.app("cycle-a", 4501, { consumeTypes: true });
  const b = f.app("cycle-b", 4502, { consumeTypes: true, remotes: [remote(a)] });
  a.remotes = [remote(b)];
  const failed = f.app("failed", 4503);
  const dependent = f.app("dependent", 4504, { consumeTypes: true, remotes: [remote(failed)] });
  const healthy = f.app("healthy", 4505);
  const unresolved = f.app("unresolved", 4506, {
    consumeTypes: true,
    remotes: [{ alias: "unknown", name: "not-in-workspace", url: null }],
  });
  const report = await rebuildAllTypes(f.context([a, b, failed, dependent, healthy, unresolved]), {
    ...unused,
    generateLocalFederatedTypes: mockGeneration((appDir) => {
      if (appDir === failed.folder) throw new Error("compiler exited 1");
      return writeZip(path.join(appDir, "dist", "@mf-types.zip"), "healthy");
    }),
  });
  assert.deepEqual(report.rebuilt, ["healthy"]);
  assert.deepEqual(report.failed, [{ app: "failed", reason: "compiler exited 1" }]);
  assert.deepEqual(report.skipped.map(({ app }) => app).sort(), [
    "cycle-a",
    "cycle-b",
    "dependent",
    "unresolved",
  ]);
  assert.match(
    report.skipped.find(({ app }) => app === a.name)?.reason ?? "",
    /cycle-a → cycle-b → cycle-a/,
  );
  assert.match(
    report.skipped.find(({ app }) => app === dependent.name)?.reason ?? "",
    /Dependency failed/,
  );
  assert.match(
    report.skipped.find(({ app }) => app === unresolved.name)?.reason ?? "",
    /Unresolved URL for unknown/,
  );
  assert.deepEqual(report.installed, []);
});

test("duplicate federation names skip both configurations and their local consumers", async (t) => {
  const f = fixture(t);
  const first = { ...f.app("first", 4601), name: "duplicate", settingsKey: "first" };
  const second = { ...f.app("second", 4602), name: "duplicate", settingsKey: "second" };
  const consumer = f.app("consumer", 4603, { consumeTypes: true, remotes: [remote(second)] });
  const independent = f.app("independent", 4604);
  const report = await rebuildAllTypes(f.context([first, second, consumer, independent]), {
    ...unused,
    generateLocalFederatedTypes: mockGeneration((folder) => {
      assert.equal(folder, independent.folder);
      return writeZip(path.join(folder, "dist", "@mf-types.zip"), "independent");
    }),
  });
  assert.deepEqual(report.rebuilt, ["independent"]);
  assert.deepEqual(
    report.skipped.map(({ app }) => app),
    ["first", "second", "consumer"],
  );
  assert.ok(report.skipped[0].reason.includes(first.configFile));
  assert.ok(report.skipped[1].reason.includes(second.configFile));
  assert.ok(report.skipped.slice(0, 2).every((item) => !item.problems?.length));
  assert.match(report.skipped[2].reason, /Dependency duplicate/);
});

test("bulk rebuild reports compiler locations, isolates config errors and keeps independent apps running", async (t) => {
  const messages: string[] = [];
  const log = createLogger({ enabled: () => true, write: (_level, text) => messages.push(text) });
  const f = fixture(t);
  const root = path.dirname(f.app("healthy", 4601).folder);
  const { folder: broken } = f.app("broken", 4602);
  const { folder: invalid } = f.app("invalid", 4603);
  const { folder: config } = f.app("bad-tsconfig", 4604);
  for (const [app, port] of [
    ["healthy", 4601],
    ["broken", 4602],
    ["bad-tsconfig", 4604],
  ] as const) {
    const folder = path.join(root, app);
    fs.writeFileSync(
      path.join(folder, "rsbuild.config.cjs"),
      `
const { pluginModuleFederation } = require('@module-federation/rsbuild-plugin');
module.exports = { server: { port: ${port} }, plugins: [pluginModuleFederation({
  name: '${app}', exposes: { './index': './index.ts' }, dts: true
})] };`,
    );
    fs.writeFileSync(path.join(folder, "tsconfig.json"), '{"include":["index.ts"]}');
  }
  fs.writeFileSync(path.join(broken, "index.ts"), '\nexport const value: number = "text";');
  fs.writeFileSync(path.join(invalid, "rsbuild.config.ts"), "// comment\nexport default }");
  fs.writeFileSync(path.join(config, "broken.json"), '{\n  "compilerOptions": }\n');
  fs.writeFileSync(path.join(config, "tsconfig.json"), '{"extends":"./broken.json"}');
  installGeneratorFixture(
    broken,
    `
const compile = require('node:util').promisify(require('node:child_process').execFile);
try {
  await compile(process.execPath, [${JSON.stringify(path.resolve("node_modules/typescript/bin/tsc"))}, '--pretty', 'false', '--noEmit', '--project', 'tsconfig.json'], { cwd: dtsManagerOptions.remote.context });
} catch { throw new Error('SDK dropped compiler output'); }
`,
  );
  installGeneratorFixture(
    path.join(root, "healthy"),
    `
const fs = require('node:fs');
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/@mf-types.zip', Buffer.concat([Buffer.from([0x50,0x4b,3,4]), Buffer.from('ok')]));
`,
  );
  const { apps, skipped } = resolveRebuildApps(
    [{ name: "root", path: root }],
    {
      apps: Object.fromEntries(
        ["healthy", "broken", "invalid", "bad-tsconfig"].map((name) => [name, { path: name }]),
      ),
      envMode: "development",
      ignorePaths: [],
      extraManifestUrls: [],
      structure: "tree",
    },
    noLog,
  );
  assert.equal(skipped[0]?.app, "invalid");
  assert.equal(skipped[0].problems?.[0].file, path.join(invalid, "rsbuild.config.ts"));
  assert.equal(skipped[0].problems?.[0].line, 2);
  const status = new Map<string, string>();
  const report = await rebuildAllTypes(
    f.context(apps, {
      log,
      status: (updates) => updates.forEach(({ app, status: next }) => status.set(app, next)),
    }),
  );
  const compiler = report.failed.find(({ app }) => app === "broken");
  assert.equal(compiler?.reason, "SDK dropped compiler output");
  assert.match(
    messages.find(
      (line) => line.startsWith("types.rebuild.all.app") && line.includes("app=broken "),
    ) ?? "",
    /status=failed.*prepareGenerationMs=\d+ inputsMs=\d+ compileMs=[1-9]\d* zipMs=0 queueMs=\d+ processMs=\d+/,
  );
  assert.deepEqual(compiler?.problems, [
    {
      file: path.join(broken, "index.ts"),
      line: 2,
      column: 14,
      code: "TS2322",
      message: "Type 'string' is not assignable to type 'number'.",
    },
  ]);
  const tsconfig = report.failed.find(({ app }) => app === "bad-tsconfig");
  assert.equal(tsconfig?.problems?.[0].file, fs.realpathSync(path.join(config, "broken.json")));
  assert.equal(tsconfig?.problems?.[0].line, 2);
  assert.deepEqual(report.rebuilt, ["healthy"]);
  assert.equal(status.get("broken"), "failed");
  assert.equal(status.get("healthy"), "rebuilt");
  fs.writeFileSync(path.join(config, "broken.json"), '{\n  "extends": "./missing.json"\n}');
  const missing = await rebuildAllTypes(
    f.context(apps.filter((app) => app.name === "bad-tsconfig")),
  );
  assert.equal(
    missing.failed[0]?.problems?.[0].file,
    fs.realpathSync(path.join(config, "broken.json")),
  );
  assert.equal(missing.failed[0]?.problems?.[0].line, 2);
  const nested = path.join(config, "nested");
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, "missing.json"), "{}");
  fs.writeFileSync(path.join(nested, "base.json"), '{"extends":"./missing.json"}');
  const rootConfig = path.join(config, "tsconfig.json");
  fs.writeFileSync(rootConfig, '{\n\n  "extends": ["./missing.json", "./nested/base.json"]\n}');
  const sameSpecifier = await rebuildAllTypes(
    f.context(apps.filter((app) => app.name === "bad-tsconfig")),
  );
  assert.equal(sameSpecifier.failed[0]?.problems?.[0].file, fs.realpathSync(rootConfig));
  assert.equal(sameSpecifier.failed[0]?.problems?.[0].line, 3);
});

for (const [mode, tsconfig] of [
  ["include", { include: ["src/**/*.ts"], exclude: ["contracts", "excluded"] }],
  ["files", { files: ["src/value.ts"] }],
] as const) {
  test(`compiler inputs outside tsconfig ${mode} invalidate the archive without scanning hook output`, async (t) => {
    const f = fixture(t);
    const { folder } = f.app("catalog", 4501);
    fs.writeFileSync(
      path.join(folder, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "esnext", moduleResolution: "bundler" },
        ...tsconfig,
      }),
    );
    const source = path.join(folder, "src", "value.ts");
    const contracts = path.join(mode === "include" ? folder : path.dirname(folder), "contracts");
    const declaration = path.join(contracts, "contract.d.ts");
    const specifier = path
      .relative(path.dirname(source), declaration)
      .split(path.sep)
      .join("/")
      .replace(/\.d\.ts$/, "");
    fs.mkdirSync(path.dirname(source));
    fs.mkdirSync(contracts);
    fs.writeFileSync(
      source,
      `import { revision } from ${JSON.stringify(specifier)};\nexport const value = revision();\n`,
    );
    const firstType = 'export declare function revision(): "first";';
    const secondType = 'export declare function revision(): "second-version";';
    fs.writeFileSync(declaration, firstType);
    fs.writeFileSync(
      path.join(folder, "rsbuild.config.cjs"),
      `
const fs = require("node:fs");
const { pluginModuleFederation } = require("@module-federation/rsbuild-plugin");
module.exports = { server: { port: 4501 }, plugins: [pluginModuleFederation({
  name: "catalog",
  exposes: { "./value": "./src/value.ts" },
  dts: { generateTypes: { afterGenerate() {
    fs.mkdirSync("package-types", { recursive: true });
    fs.writeFileSync("package-types/hook.d.ts", "export declare const generated: true;");
  } } }
})] };
`,
    );
    installGeneratorFixture(
      folder,
      `
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/@mf-types.zip", Buffer.concat([
  Buffer.from([0x50, 0x4b, 3, 4]), fs.readFileSync(${JSON.stringify(declaration)})
]));
`,
    );
    const catalog = readAppFolder(folder, "development", "catalog");
    assert.ok(catalog?.generateTypes);
    const shell = f.app("shell", 4502, {
      hasExposes: false,
      consumeTypes: true,
      remotes: [remote(catalog)],
    });
    const context = f.context([catalog, shell]);
    const excluded = path.join(folder, "excluded");
    fs.mkdirSync(excluded);
    fs.chmodSync(excluded, 0o000);
    try {
      const first = await rebuildAllTypes(context);
      assert.deepEqual(first.failed, []);
      assert.deepEqual(first.rebuilt, ["catalog"]);
      assert.ok(fs.existsSync(path.join(folder, "package-types", "hook.d.ts")));
      assert.equal(fs.readFileSync(typeFile(shell, "catalog"), "utf8"), firstType);
      assert.deepEqual((await rebuildAllTypes(context)).current, ["catalog"]);

      fs.writeFileSync(declaration, secondType);
      const updated = await rebuildAllTypes(context);
      assert.deepEqual(updated.failed, []);
      assert.deepEqual(updated.rebuilt, ["catalog"]);
      assert.equal(fs.readFileSync(typeFile(shell, "catalog"), "utf8"), secondType);
      assert.equal(
        f.confirmations.generation(catalog.name)?.sourceFingerprint,
        sourceIdentity(catalog.folder, catalog.tsconfig, catalog.typesFolder).fingerprint,
      );
      assert.deepEqual((await rebuildAllTypes(context)).current, ["catalog"]);
    } finally {
      fs.chmodSync(excluded, 0o700);
    }
  });
}

test("a missing manifest URL uses the ZIP of the named workspace dependency", async (t) => {
  const f = fixture(t);
  const catalog = f.app("catalog", 4501);
  const shell = f.app("shell", 4502, {
    consumeTypes: true,
    remotes: [{ ...remote(catalog), url: null }],
  });
  const report = await rebuildAllTypes(f.context([shell, catalog], { target: shell.name }), {
    ...unused,
    generateLocalFederatedTypes: mockGeneration((folder) =>
      writeZip(path.join(folder, "dist", "@mf-types.zip"), path.basename(folder)),
    ),
  });
  assert.deepEqual(report.rebuilt, [catalog.name, shell.name]);
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.skipped, []);
  assert.equal(fs.readFileSync(typeFile(shell, catalog.name), "utf8"), catalog.name);
});

test("bulk and single builds use workspace types when configured external manifests are unavailable", async (t) => {
  const f = fixture(t);
  const schema = f.app("schema", 4501);
  const unreachable = (app: LocalApp) => ({
    ...remote(app),
    url: `https://unavailable.example/${app.name}/mf-manifest.json`,
  });
  const catalog = f.app("catalog", 4502, {
    consumeTypes: true,
    remotes: [unreachable(schema)],
  });
  const shell = f.app("shell", 4503, {
    consumeTypes: true,
    remotes: [unreachable(catalog), unreachable(schema)],
  });
  const unrelated = f.app("unrelated", 4504);
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
  const io = {
    ...unused,
    installRemoteTypes,
    generateLocalFederatedTypes: mockGeneration((folder) =>
      writeZip(path.join(folder, "dist", "@mf-types.zip"), path.basename(folder)),
    ),
  };
  const apps = [shell, catalog, unrelated, schema];
  const installedByApp = new Map<string, readonly string[]>();
  const single = await rebuildAllTypes(
    f.context(apps, {
      target: shell.name,
      status(rows) {
        for (const row of rows) if (row.installed) installedByApp.set(row.app, row.installed);
      },
    }),
    io,
  );
  assert.deepEqual(single.failed, []);
  assert.deepEqual(single.rebuilt, [schema.name, catalog.name, shell.name]);
  assert.equal(fetch.mock.callCount(), 3);
  assert.equal(fs.readFileSync(typeFile(shell, catalog.name), "utf8"), catalog.name);
  assert.equal(fs.readFileSync(typeFile(shell, schema.name), "utf8"), schema.name);
  assert.deepEqual(installedByApp.get(shell.name), [catalog.name, schema.name]);
  assert.deepEqual(installedByApp.get(catalog.name), [schema.name]);
  assert.equal(
    f.confirmations.install({
      consumer: shell.name,
      alias: catalog.name,
      remoteName: catalog.name,
    })?.fromManifest,
    false,
  );
  const bulk = await rebuildAllTypes(f.context(apps), io);
  assert.deepEqual(bulk.failed, []);
  assert.ok(bulk.rebuilt.includes(unrelated.name));
});

test("a single rebuild with available or already installed staging types leaves the local fallback alone", async (t) => {
  const f = fixture(t);
  const catalog = f.app("catalog", 4501);
  const stagingUrl = "https://staging.example/catalog/mf-manifest.json";
  const shell = f.app("shell", 4502, {
    consumeTypes: true,
    remotes: [{ ...remote(catalog), url: stagingUrl }],
  });
  const stagingZip = writeZip(path.join(catalog.folder, "staging.zip"), "staging");
  serveZip(t, stagingUrl, stagingZip.zipPath);
  const statusNames = new Set<string>();
  const context = f.context([catalog, shell], {
    target: shell.name,
    status: (rows) => rows.forEach(({ app }) => statusNames.add(app)),
  });
  const io = {
    ...unused,
    installRemoteTypes,
    generateLocalFederatedTypes: mockGeneration((folder) => {
      assert.equal(folder, shell.folder);
      const stagingTypes = fs.readFileSync(typeFile(shell, catalog.name), "utf8");
      return writeZip(path.join(folder, "dist", "@mf-types.zip"), stagingTypes);
    }),
  };
  const first = await rebuildAllTypes(context, io);
  assert.deepEqual(first.failed, []);
  assert.deepEqual(first.rebuilt, [shell.name]);
  assert.equal(fs.readFileSync(typeFile(shell, catalog.name), "utf8"), "staging");

  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
  const second = await rebuildAllTypes(context, io);
  assert.deepEqual(second.failed, []);
  assert.deepEqual(second.rebuilt, [shell.name]);
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(statusNames, new Set([shell.name]));
});

for (const [mode, unavailable] of [
  ["bulk", "alpha"],
  ["bulk", "beta"],
  ["single", "alpha"],
]) {
  test(`${mode} rebuild resolves mutual external links when the ${unavailable} manifest returns 503`, async (t) => {
    const f = fixture(t);
    const alpha = f.app("alpha", 4501, { consumeTypes: true, remotes: [] });
    const beta = f.app("beta", 4502, { consumeTypes: true, remotes: [] });
    const origin = (name: string) => `https://staging.example/${name}/`;
    const staged = (app: LocalApp) => ({
      ...remote(app),
      url: `${origin(app.name)}mf-manifest.json`,
    });
    alpha.remotes.push(staged(beta));
    beta.remotes.push(staged(alpha));
    const [producer, consumer] = unavailable === alpha.name ? [alpha, beta] : [beta, alpha];
    const archive = writeZip(path.join(consumer.folder, "staging.zip"), "staging");
    const fetch = t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      if (String(input) === staged(producer).url) return new Response(null, { status: 503 });
      if (String(input) === staged(consumer).url)
        return Response.json({
          metaData: { publicPath: origin(consumer.name), types: { zip: "types.zip" } },
        });
      assert.equal(String(input), `${origin(consumer.name)}types.zip`);
      return new Response(fs.readFileSync(archive.zipPath));
    });
    const target = mode === "single" ? consumer.name : undefined;
    const report = await rebuildAllTypes(f.context([alpha, beta], { target }), {
      ...unused,
      installRemoteTypes,
      generateLocalFederatedTypes: mockGeneration((folder) =>
        writeZip(path.join(folder, "dist", "@mf-types.zip"), path.basename(folder)),
      ),
    });
    assert.deepEqual(report.failed, []);
    assert.deepEqual(report.skipped, []);
    assert.deepEqual(report.rebuilt, [producer.name, consumer.name]);
    assert.equal(fetch.mock.callCount(), 3);
    assert.equal(fs.readFileSync(typeFile(producer, consumer.name), "utf8"), "staging");
    assert.equal(fs.readFileSync(typeFile(consumer, producer.name), "utf8"), producer.name);
  });
}

test("a possible local fallback does not create a cycle when the external manifest is available", async (t) => {
  const f = fixture(t);
  const shell = f.app("shell", 4501, { consumeTypes: true, remotes: [] });
  const catalog = f.app("catalog", 4502, { consumeTypes: true, remotes: [remote(shell)] });
  const stagingUrl = `https://staging.example/${catalog.name}/mf-manifest.json`;
  shell.remotes.push({ ...remote(catalog), url: stagingUrl });
  const stagingZip = writeZip(path.join(catalog.folder, "staging.zip"), "staging");
  serveZip(t, stagingUrl, stagingZip.zipPath);
  const report = await rebuildAllTypes(f.context([shell, catalog]), {
    ...unused,
    installRemoteTypes,
    generateLocalFederatedTypes: mockGeneration((folder) =>
      writeZip(path.join(folder, "dist", "@mf-types.zip"), path.basename(folder)),
    ),
  });
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.skipped, []);
  assert.deepEqual(report.rebuilt, [shell.name, catalog.name]);
  assert.equal(fs.readFileSync(typeFile(shell, catalog.name), "utf8"), "staging");
});

test("a staging URL uses external types even when a same-named local producer fails", async (t) => {
  const f = fixture(t);
  const catalog = f.app("catalog", 4501);
  const staging = "https://staging.example/catalog/mf-manifest.json";
  const shell = f.app("shell", 4502, {
    consumeTypes: true,
    remotes: [{ alias: "catalog", name: "catalog", url: staging }],
  });
  const file = typeFile(shell, "catalog");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "local catalog from a per-row rebuild");
  f.confirmations.saveInstall(
    { consumer: shell.name, alias: "catalog", remoteName: catalog.name, url: staging },
    treeFingerprint(path.dirname(file)),
    "local-zip",
  );
  const requests: string[] = [];
  const context = f.context([catalog, shell]);
  const io: NonNullable<Parameters<typeof rebuildAllTypes>[1]> = {
    ...unused,
    async installRemoteTypes(app, dependency, url) {
      requests.push(url);
      const file = typeFile(app, dependency.alias);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "staging");
      return { zipHash: "staging", filesFingerprint: treeFingerprint(path.dirname(file)) };
    },
    generateLocalFederatedTypes: mockGeneration((appDir) => {
      if (appDir === catalog.folder) throw new Error("catalog unavailable");
      return writeZip(
        path.join(appDir, "dist", "@mf-types.zip"),
        fs.readFileSync(typeFile(shell, "catalog"), "utf8"),
      );
    }),
  };
  const report = await rebuildAllTypes(context, io);
  assert.deepEqual(requests, [staging]);
  assert.deepEqual(report.rebuilt, ["shell"]);
  assert.deepEqual(report.failed, [{ app: "catalog", reason: "catalog unavailable" }]);
  assert.deepEqual(report.skipped, []);
  assert.equal(fs.readFileSync(typeFile(shell, "catalog"), "utf8"), "staging");
  const second = await rebuildAllTypes(context, io);
  assert.deepEqual(second.current, ["shell"]);
  assert.deepEqual(requests, [staging]);
});

test("bulk rebuild fetches scoped remote types into the nested directory before generating", async (t) => {
  const f = fixture(t);
  const alias = "@fixture/ui-kit";
  const origin = "https://assets.example.test/";
  const manifestUrl = `${origin}mf-manifest.json`;
  const zipUrl = `${origin}types.zip`;
  const consumer = f.app("fixture-client", 4502, {
    consumeTypes: true,
    remotes: [{ alias, name: "fixture-library", url: manifestUrl }],
  });
  const content = 'export declare const version: "fixture";';
  const archive = writeZip(path.join(consumer.folder, "fixture.zip"), content);
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    requests.push(String(input));
    if (String(input) === manifestUrl)
      return Response.json({ metaData: { publicPath: origin, types: { zip: "types.zip" } } });
    assert.equal(String(input), zipUrl);
    return new Response(fs.readFileSync(archive.zipPath));
  });
  const report = await rebuildAllTypes(f.context([consumer]), {
    ...unused,
    installRemoteTypes,
    generateLocalFederatedTypes: mockGeneration((appDir) => {
      assert.equal(fs.readFileSync(typeFile(consumer, alias), "utf8"), content);
      return writeZip(path.join(appDir, "dist", "@mf-types.zip"), content);
    }),
  });
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.rebuilt, [consumer.name]);
  assert.deepEqual(report.installed, [{ consumer: consumer.name, alias }]);
  assert.deepEqual(requests, [manifestUrl, zipUrl]);
});

for (const source of ["manifest", "local"] as const) {
  test(`scoped install rejects a scope replaced while loading a ${source} ZIP`, async (t) => {
    const f = fixture(t);
    const alias = "@fixture/widget";
    const origin = "https://assets.example.test/";
    const manifestUrl = `${origin}mf-manifest.json`;
    const dependency = { alias, name: "fixture-library", url: manifestUrl };
    const consumer = f.app("fixture-client", 4502, { remotes: [dependency] });
    const unrelated = f.app("fixture-unrelated", 4503);
    const installed = typeFile(consumer, alias);
    const destination = path.dirname(installed);
    const scope = path.dirname(destination);
    const oldScope = `${scope}-old`;
    const unrelatedTypes = path.join(unrelated.folder, "widget", "index.d.ts");
    fs.mkdirSync(destination, { recursive: true });
    fs.mkdirSync(path.dirname(unrelatedTypes), { recursive: true });
    fs.writeFileSync(installed, "previous");
    fs.writeFileSync(unrelatedTypes, "keep");
    const { zipPath, zipHash } = writeZip(path.join(consumer.folder, "fixture.zip"), "new");
    const replaceScope = () => {
      fs.renameSync(scope, oldScope);
      fs.symlinkSync(unrelated.folder, scope, "junction");
    };

    let pending: Promise<unknown>;
    if (source === "manifest") {
      t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
        if (String(input) === manifestUrl)
          return Response.json({ metaData: { publicPath: origin, types: { zip: "types.zip" } } });
        assert.equal(String(input), `${origin}types.zip`);
        replaceScope();
        return new Response(fs.readFileSync(zipPath));
      });
      pending = installRemoteTypes(consumer, dependency, manifestUrl, "");
    } else {
      pending = installLocalTypesArchive({
        zipPath,
        expectedZipHash: zipHash,
        destination,
        appDir: consumer.folder,
      });
      await Promise.resolve();
      replaceScope();
    }

    await assert.rejects(pending, (error: unknown) => {
      const { stage, reason } = safeError(error);
      assert.equal(stage, "destination");
      assert.equal(reason, "path-escape");
      return true;
    });
    assert.equal(fs.readFileSync(unrelatedTypes, "utf8"), "keep");
    assert.equal(fs.readFileSync(path.join(oldScope, "widget", "index.d.ts"), "utf8"), "previous");
    assert.deepEqual(fs.readdirSync(unrelated.folder).sort(), ["index.ts", "widget"]);
  });
}

test("a missing scope still protects its existing types root while a ZIP loads", async (t) => {
  const f = fixture(t);
  const app = f.app("fixture-client", 4502);
  const root = path.join(app.folder, app.typesFolder);
  const installed = typeFile(app, "@fixture/widget");
  const archive = writeZip(path.join(app.folder, "fixture.zip"), "new");
  fs.mkdirSync(root);

  await assert.rejects(
    () =>
      installTypesArchive({
        appDir: app.folder,
        destination: path.dirname(installed),
        url: "https://assets.example.test/types.zip",
        fetchImpl: async () => {
          fs.renameSync(root, `${root}-old`);
          fs.mkdirSync(path.dirname(installed), { recursive: true });
          fs.writeFileSync(installed, "previous");
          return new Response(fs.readFileSync(archive.zipPath));
        },
      }),
    (error: unknown) => {
      assert.equal(safeError(error).reason, "path-escape");
      return true;
    },
  );
  assert.equal(fs.readFileSync(installed, "utf8"), "previous");
});

test(
  "Fetch writes through a relative symlink in filesystem order",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = fixture(t);
    const dependency = {
      alias: "@fixture/widget",
      name: "fixture-library",
      url: "https://fixture.example/mf-manifest.json",
    };
    const app = f.app("fixture-client", 4502, {
      consumeTypes: true,
      typesFolder: "linked-types",
      remotes: [dependency],
    });
    const unrelated = typeFile({ ...app, typesFolder: "types" }, dependency.alias);
    fs.mkdirSync(path.join(app.folder, "group", "nested"), { recursive: true });
    fs.mkdirSync(path.join(app.folder, "group", "types"));
    fs.mkdirSync(path.dirname(unrelated), { recursive: true });
    fs.writeFileSync(unrelated, "keep");
    fs.symlinkSync("group/nested", path.join(app.folder, "jump"), "dir");
    fs.symlinkSync("jump/../types", path.join(app.folder, app.typesFolder), "dir");
    const archive = writeZip(path.join(app.folder, "fixture.zip"), "new");
    serveZip(t, dependency.url, archive.zipPath);

    await installRemoteTypes(app, dependency, dependency.url, "");
    assert.equal(fs.readFileSync(typeFile(app, dependency.alias), "utf8"), "new");
    assert.equal(fs.readFileSync(unrelated, "utf8"), "keep");
  },
);

for (const source of ["HTTP", "local"] as const) {
  test(`installation checks for new overlaps after loading a ${source} ZIP`, async (t) => {
    const f = fixture(t);
    const producer = f.app("fixture-library", 4501);
    const flat = remote(producer, "@fixture");
    const first = f.app("fixture-flat", 4502, {
      consumeTypes: true,
      generateTypes: false,
      remotes: [flat],
    });
    const scoped = {
      alias: "@library/widget",
      name: "other",
      url: "https://fixture.example/mf-manifest.json",
    };
    const second = localApp("fixture-scoped", first.folder, {
      consumeTypes: true,
      generateTypes: false,
      typesFolder: "linked-types",
      remotes: [scoped],
    });
    const root = path.join(first.folder, first.typesFolder);
    const link = path.join(second.folder, second.typesFolder);
    const intermediate = path.join(root, flat.alias, "types-link");
    const existing = path.join(root, scoped.alias, "index.d.ts");
    fs.mkdirSync(path.dirname(existing), { recursive: true });
    fs.mkdirSync(path.dirname(intermediate));
    fs.writeFileSync(existing, "previous");
    fs.symlinkSync(root, link, "junction");
    const archive = writeZip(path.join(producer.folder, "fixture.zip"), "new");
    const relink = () => {
      fs.unlinkSync(link);
      fs.symlinkSync(root, intermediate, "junction");
      fs.symlinkSync(intermediate, link, "junction");
    };

    if (source === "HTTP") {
      serveZip(t, flat.url, archive.zipPath, relink);
      await assert.rejects(
        () => installRemoteTypes(first, flat, flat.url, "", undefined, undefined, [first, second]),
        /remote aliases share a types directory/,
      );
    } else {
      const readFile = fs.promises.readFile;
      const mock = t.mock.method(
        fs.promises,
        "readFile",
        async (...args: Parameters<typeof readFile>) => {
          if (args[0] === archive.zipPath) relink();
          return readFile(...args);
        },
      );
      syncBuiltinESMExports();
      try {
        const report = await rebuildAllTypes(f.context([producer, first, second]), {
          ...unused,
          async generateLocalFederatedTypes() {
            return { ...archive, current: false, inputsFingerprint: null };
          },
        });
        assert.deepEqual(report.installed, []);
        assert.deepEqual(report.failed, [
          { app: first.name, reason: `remote aliases share a types directory: ${flat.alias}` },
        ]);
      } finally {
        mock.mock.restore();
        syncBuiltinESMExports();
      }
    }
    assert.equal(fs.readFileSync(typeFile(second, scoped.alias), "utf8"), "previous");
    assert.deepEqual(fs.readdirSync(root).sort(), [flat.alias, "@library"]);
  });
}

test("archive installation normalizes a destination ending in a dot component", async (t) => {
  const f = fixture(t);
  const app = f.app("fixture-client", 4502);
  const target = typeFile(app, "widget");
  const sibling = typeFile(app, "sibling");
  fs.mkdirSync(path.dirname(sibling), { recursive: true });
  fs.writeFileSync(sibling, "keep");
  const archive = writeZip(path.join(app.folder, "fixture.zip"), "new");

  await installTypesArchive({
    appDir: app.folder,
    destination: `${path.dirname(target)}${path.sep}.`,
    url: "https://fixture.example/types.zip",
    fetchImpl: async () => new Response(fs.readFileSync(archive.zipPath)),
  });
  assert.equal(fs.readFileSync(target, "utf8"), "new");
  assert.equal(fs.readFileSync(sibling, "utf8"), "keep");
});

const composedName = "caf\u00e9";
const decomposedName = composedName.normalize("NFD");
const overlapFixtures = [
  {
    name: "a linked alias's backing directory",
    alias: "@fixture/widget",
    protectedAlias: "other",
    protectedFolder: "@mf-types",
    physicalFolder: "@mf-types/@fixture/widget/nested",
    link: "@mf-types/other",
    linkTarget: "@mf-types/@fixture/widget/nested",
  },
  {
    name: "a directory traversed before ..",
    alias: "@fixture",
    protectedAlias: "@library/widget",
    protectedFolder: "linked-types",
    physicalFolder: "@mf-types/other/@library/widget",
    link: "linked-types",
    relativeTarget: "@mf-types/@fixture/nested/../../other",
  },
  {
    name: "an existing directory with an equivalent Unicode name",
    alias: decomposedName,
    protectedAlias: "@library/widget",
    protectedFolder: `@mf-types/${composedName}`,
    physicalFolder: `@mf-types/${composedName}/@library/widget`,
    equivalentName: composedName,
  },
  {
    name: "a symlink entry with an equivalent Unicode name",
    alias: decomposedName,
    protectedAlias: "@library/widget",
    protectedFolder: `@mf-types/${composedName}`,
    physicalFolder: "actual/@library/widget",
    link: `@mf-types/${composedName}`,
    linkTarget: "actual",
    equivalentName: composedName,
  },
  {
    name: "a hard-linked symlink with a filesystem-equivalent name",
    alias: "\u03c3",
    protectedAlias: "@library/widget",
    protectedFolder: "linked-types",
    physicalFolder: "actual/@library/widget",
    link: "@mf-types/\u03c2",
    linkTarget: "actual",
    equivalentName: "\u03c2",
    hardLink: true,
  },
  {
    name: "a hard-linked symlink when directory listing is denied",
    alias: "linked-target",
    protectedAlias: "@library/widget",
    protectedFolder: "linked-types",
    physicalFolder: "actual/@library/widget",
    link: "@mf-types/linked-target",
    linkTarget: "actual",
    hardLink: true,
    denyList: true,
  },
] as const;

for (const scenario of overlapFixtures) {
  test(`Fetch and local rebuild protect ${scenario.name}`, async (t) => {
    if ("relativeTarget" in scenario && process.platform === "win32") {
      t.skip("requires POSIX relative symlink traversal");
      return;
    }
    if ("hardLink" in scenario && process.platform === "win32") {
      t.skip("requires POSIX hard links to symlinks");
      return;
    }
    const f = fixture(t);
    const producer = f.app("fixture-library", 4501);
    const dependency = remote(producer, scenario.alias);
    const consumer = f.app("fixture-consumer", 4502, {
      consumeTypes: true,
      generateTypes: false,
      remotes: [dependency],
    });
    const other = localApp("fixture-other", consumer.folder, {
      consumeTypes: true,
      generateTypes: false,
      typesFolder: scenario.protectedFolder,
      remotes: [
        {
          alias: scenario.protectedAlias,
          name: "other",
          url: "https://fixture.example/mf-manifest.json",
        },
      ],
    });
    const physical = path.join(consumer.folder, scenario.physicalFolder);
    const installed = typeFile(other, scenario.protectedAlias);
    fs.mkdirSync(physical, { recursive: true });
    fs.writeFileSync(path.join(physical, "index.d.ts"), "previous");
    if ("link" in scenario) {
      const link = path.join(consumer.folder, scenario.link);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      if ("relativeTarget" in scenario) {
        fs.mkdirSync(path.join(consumer.folder, "@mf-types", scenario.alias, "nested"), {
          recursive: true,
        });
        fs.symlinkSync(scenario.relativeTarget, link, "dir");
      } else {
        fs.symlinkSync(path.join(consumer.folder, scenario.linkTarget), link, "junction");
      }
      if ("hardLink" in scenario) {
        execFileSync("ln", ["-P", link, path.join(path.dirname(link), "other-entry")]);
        fs.symlinkSync(link, path.join(consumer.folder, scenario.protectedFolder), "junction");
      }
    }
    const typeRoot = path.join(consumer.folder, consumer.typesFolder);
    if ("equivalentName" in scenario) {
      const existing = fs.lstatSync(path.join(typeRoot, scenario.equivalentName), { bigint: true });
      const alternate = fs.lstatSync(path.join(typeRoot, scenario.alias), {
        bigint: true,
        throwIfNoEntry: false,
      });
      if (alternate?.ino !== existing.ino || alternate.dev !== existing.dev) {
        t.skip("requires a filesystem with equivalent Unicode names");
        return;
      }
    }
    let deniedReads = 0;
    if ("denyList" in scenario) {
      const denied = fs.realpathSync.native(typeRoot);
      const readdir = fs.readdirSync;
      t.mock.method(fs, "readdirSync", (...args: Parameters<typeof readdir>) => {
        if (args[0] === denied) {
          deniedReads++;
          throw Object.assign(new Error("cannot list fixture types folder"), { code: "EACCES" });
        }
        return readdir(...args);
      });
    }
    assert.equal(fs.readFileSync(installed, "utf8"), "previous");
    const archive = writeZip(path.join(producer.folder, "fixture.zip"), "new");
    const apps = [producer, consumer, other];
    serveZip(t, dependency.url, archive.zipPath);

    await assert.rejects(
      () =>
        installRemoteTypes(consumer, dependency, dependency.url, "", undefined, undefined, apps),
      /remote aliases share a types directory/,
    );
    assert.equal(fs.readFileSync(installed, "utf8"), "previous");

    const report = await rebuildAllTypes(f.context(apps), {
      ...unused,
      async generateLocalFederatedTypes() {
        return { ...archive, current: false, inputsFingerprint: null };
      },
    });
    assert.deepEqual(report.installed, []);
    assert.deepEqual(report.failed, [
      { app: consumer.name, reason: `remote aliases share a types directory: ${scenario.alias}` },
    ]);
    assert.equal(fs.readFileSync(installed, "utf8"), "previous");
    if ("denyList" in scenario) assert.ok(deniedReads > 0);
  });
}

test(
  "Fetch can replace one hard-linked alias entry without changing the others",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = fixture(t);
    const producer = f.app("fixture-library", 4501);
    const dependency = remote(producer, "@fixture/widget");
    const related = [remote(producer, "@fixture/other"), remote(producer, "@library/widget")];
    const app = f.app("fixture-consumer", 4502, {
      consumeTypes: true,
      remotes: [dependency, ...related],
    });
    const types = path.join(app.folder, app.typesFolder);
    for (const scope of ["@fixture", "@library"]) {
      const backing = path.join(types, scope, "backing");
      fs.mkdirSync(backing, { recursive: true });
      fs.writeFileSync(path.join(backing, "index.d.ts"), scope);
    }
    const destination = path.join(types, dependency.alias);
    fs.symlinkSync("backing", destination, "dir");
    for (const { alias } of related)
      execFileSync("ln", ["-P", destination, path.join(types, alias)]);
    const archive = writeZip(path.join(producer.folder, "fixture.zip"), "new");
    serveZip(t, dependency.url, archive.zipPath);

    await installRemoteTypes(app, dependency, dependency.url, "");
    assert.equal(fs.readFileSync(typeFile(app, dependency.alias), "utf8"), "new");
    assert.equal(fs.readFileSync(typeFile(app, related[0].alias), "utf8"), "@fixture");
    assert.equal(fs.readFileSync(typeFile(app, related[1].alias), "utf8"), "@library");
  },
);

test("bulk rebuild preserves installed scoped types when another config owns their parent", async (t) => {
  const f = fixture(t);
  const producer = f.app("fixture-library", 4501);
  const scoped = f.app("fixture-scoped", 4502, {
    consumeTypes: true,
    generateTypes: false,
    remotes: [remote(producer, "@fixture/widget")],
  });
  const flat = localApp("fixture-flat", scoped.folder, {
    port: 4503,
    configFile: path.join(scoped.folder, "webpack.config.ts"),
    typesFolder: `./${scoped.typesFolder}`,
    consumeTypes: true,
    generateTypes: false,
    remotes: [remote(producer, "@fixture")],
  });
  const installed = typeFile(scoped, "@fixture/widget");
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(installed, "previous");

  const report = await rebuildAllTypes(f.context([flat, producer, scoped]), {
    ...unused,
    generateLocalFederatedTypes: mockGeneration((appDir) =>
      writeZip(path.join(appDir, "dist", "@mf-types.zip"), "new"),
    ),
  });
  assert.deepEqual(report.rebuilt, [producer.name]);
  assert.deepEqual(report.installed, []);
  assert.deepEqual(
    report.failed.map(({ app }) => app),
    [flat.name, scoped.name],
  );
  for (const { reason } of report.failed)
    assert.match(reason, /remote aliases share a types directory/);
  assert.equal(fs.readFileSync(installed, "utf8"), "previous");
});

test("types verified against a staging manifest can be reused when staging is offline", async (t) => {
  const f = fixture(t);
  const catalog = f.app("catalog", 4501);
  const staging = "https://staging.example/catalog/";
  const url = `${staging}mf-manifest.json`;
  const zipUrl = `${staging}@mf-types.zip`;
  const shell = f.app("shell", 4502, {
    consumeTypes: true,
    remotes: [{ alias: "catalog", name: catalog.name, url }],
  });
  const file = typeFile(shell, "catalog");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "staging types");
  const bytes = zipFixture([{ file: "index.d.ts", text: "staging types" }]);
  const link = { consumer: shell.name, alias: "catalog", remoteName: catalog.name, url };
  const book = createProbeBook();
  putLinkResult(book, {
    link,
    manifestReachable: true,
    buildVersion: null,
    zipUrl,
    zipHash: createHash("sha256").update(bytes).digest("hex"),
    zipMtime: null,
    exposes: [],
    shared: [],
  });
  let online = true;
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    requests.push(String(input));
    if (!online) throw new Error("staging is offline");
    return new Response(bytes);
  });
  const apps = [shell, catalog];
  assert.equal(await verifyTypeInstalls(apps, [link], book, f.confirmations, new Map()), true);
  online = false;
  const confirmations = createConfirmationStore(f.confirmations.snapshot());
  const report = await rebuildAllTypes(f.context(apps, { confirmations }), {
    ...unused,
    installRemoteTypes,
    generateLocalFederatedTypes: mockGeneration((appDir) => {
      const types = appDir === shell.folder ? fs.readFileSync(file, "utf8") : "local catalog";
      return writeZip(path.join(appDir, "dist", "@mf-types.zip"), types);
    }),
  });
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.rebuilt, ["catalog", "shell"]);
  assert.deepEqual(requests, [zipUrl]);
});

test("types from a local substitute are replaced after its producer leaves the workspace", async (t) => {
  const f = fixture(t);
  const catalog = f.app("catalog", 4501);
  const dependency = remote(catalog);
  const shell = f.app("shell", 4502, {
    consumeTypes: true,
    remotes: [dependency],
  });
  const file = typeFile(shell, "catalog");
  const link = {
    consumer: shell.name,
    alias: dependency.alias,
    remoteName: dependency.name,
    url: dependency.url,
  };
  const requests: string[] = [];
  const io: NonNullable<Parameters<typeof rebuildAllTypes>[1]> = {
    ...unused,
    async installRemoteTypes(_app, _dependency, manifestUrl) {
      requests.push(manifestUrl);
      fs.writeFileSync(file, "manifest types");
      return { zipHash: "manifest-zip", filesFingerprint: treeFingerprint(path.dirname(file)) };
    },
    generateLocalFederatedTypes: mockGeneration((appDir) => {
      const types = appDir === catalog.folder ? "local-only types" : fs.readFileSync(file, "utf8");
      return writeZip(path.join(appDir, "dist", "@mf-types.zip"), types);
    }),
  };
  const first = await rebuildAllTypes(f.context([catalog, shell]), io);
  assert.deepEqual(first.failed, []);
  assert.deepEqual(first.installed, [{ consumer: "shell", alias: "catalog" }]);
  assert.deepEqual(requests, []);
  assert.equal(f.confirmations.install(link)?.fromManifest, false);

  const confirmations = createConfirmationStore(f.confirmations.snapshot());
  const context = f.context([shell], { confirmations });
  const report = await rebuildAllTypes(context, io);
  assert.deepEqual(requests, [dependency.url]);
  assert.deepEqual(report.rebuilt, ["shell"]);
  assert.match(
    fs.readFileSync(path.join(shell.folder, "dist", "@mf-types.zip"), "utf8"),
    /manifest types/,
  );
  assert.equal(confirmations.install(link)?.fromManifest, true);
  assert.deepEqual((await rebuildAllTypes(context, io)).current, ["shell"]);
  assert.deepEqual(requests, [dependency.url]);
});

test("changing the external remote behind an alias replaces the previously installed types", async (t) => {
  const f = fixture(t);
  const url = "https://staging.example/catalog-v2/mf-manifest.json";
  const shell = f.app("shell", 4502, {
    consumeTypes: true,
    remotes: [{ alias: "catalog", name: "catalog-v2", url }],
  });
  const file = typeFile(shell, "catalog");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "catalog-v1");
  const oldLink = {
    consumer: shell.name,
    alias: "catalog",
    remoteName: "catalog-v1",
    url: "https://staging.example/catalog-v1/mf-manifest.json",
  };
  f.confirmations.saveInstall(oldLink, treeFingerprint(path.dirname(file)), "old-zip", true);
  const confirmations = createConfirmationStore(f.confirmations.snapshot());
  const requests: string[] = [];
  const report = await rebuildAllTypes(f.context([shell], { confirmations }), {
    ...unused,
    async installRemoteTypes(_app, dependency, manifestUrl) {
      requests.push(manifestUrl);
      fs.writeFileSync(file, dependency.name);
      return { zipHash: "new-zip", filesFingerprint: treeFingerprint(path.dirname(file)) };
    },
    generateLocalFederatedTypes: mockGeneration((appDir) => {
      assert.equal(fs.readFileSync(file, "utf8"), "catalog-v2");
      return writeZip(path.join(appDir, "dist", "@mf-types.zip"), "catalog-v2");
    }),
  });
  assert.deepEqual(requests, [url]);
  assert.deepEqual(report.rebuilt, ["shell"]);
  assert.equal(confirmations.install(oldLink), null);
});

test("a legacy alias snapshot reuses the record matching the configured remote and its files", async (t) => {
  const f = fixture(t);
  const url = "https://staging.example/catalog-a/mf-manifest.json";
  const shell = f.app("shell", 4502, {
    consumeTypes: true,
    remotes: [{ alias: "catalog", name: "catalog-a", url }],
  });
  const file = typeFile(shell, "catalog");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "current catalog-a");
  const current = {
    consumer: shell.name,
    alias: "catalog",
    remoteName: "catalog-a",
    url,
    filesFingerprint: treeFingerprint(path.dirname(file)),
    zipHash: "current-a",
  };
  // The old store kept A in its original position when it was reinstalled after B.
  const confirmations = createConfirmationStore({
    installs: [
      current,
      {
        ...current,
        remoteName: "catalog-b",
        url: "https://staging.example/catalog-b/mf-manifest.json",
        filesFingerprint: "old-b",
        zipHash: "old-b",
      },
    ],
    generations: [],
  });
  const restored = createConfirmationStore(confirmations.snapshot());
  const context = f.context([shell], { confirmations: restored });
  const io = {
    ...unused,
    generateLocalFederatedTypes: mockGeneration((appDir) => {
      return writeZip(path.join(appDir, "dist", "@mf-types.zip"), fs.readFileSync(file, "utf8"));
    }),
  };
  const report = await rebuildAllTypes(context, io);
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.rebuilt, ["shell"]);
  assert.match(
    fs.readFileSync(path.join(shell.folder, "dist", "@mf-types.zip"), "utf8"),
    /current catalog-a/,
  );

  fs.writeFileSync(file, "unconfirmed catalog-a");
  const changed = await rebuildAllTypes(context, io);
  assert.deepEqual(changed.failed, [{ app: "shell", reason: "unexpected HTTP request" }]);
  assert.deepEqual(changed.current, []);
});

test("the built-in generator calls a Rsbuild config function with the discovery environment", async (t) => {
  const f = fixture(t);
  const { folder } = f.app("catalog", 4501);
  const envKey = "MF_DASHBOARD_TEST_GENERATION_MODE";
  const original = process.env[envKey];
  fs.writeFileSync(path.join(folder, ".env.development"), `${envKey}=base\n`);
  fs.writeFileSync(
    path.join(folder, ".env.development.local"),
    `${envKey}=local\nNODE_ENV=development\n`,
  );
  fs.writeFileSync(path.join(folder, "tsconfig.json"), '{"files":["index.ts"]}');
  fs.writeFileSync(
    path.join(folder, "rsbuild.config.cjs"),
    `
const { pluginModuleFederation } = require("@module-federation/rsbuild-plugin");
const fs = require("node:fs");
module.exports = ({ command, env, envMode }) => {
  if ((command !== "build" && command !== "dev") || env !== "development" || envMode !== "development")
    throw new Error("unexpected Rsbuild config parameters");
  fs.writeFileSync("config-command.txt", command);
  return { plugins: [pluginModuleFederation({
    name: "catalog",
    exposes: { "./index": "./index.ts" },
    dts: { generateTypes: process.env.${envKey} === "local" ? true : false }
  })] };
};
`,
  );
  installGeneratorFixture(
    folder,
    `
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/@mf-types.zip", Buffer.concat([
  Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from(process.env.${envKey})
]));
`,
  );
  const app = readAppFolder(folder, "development", "catalog");
  assert.ok(app?.generateTypes);
  assert.equal(fs.existsSync(path.join(folder, "config-command.txt")), false);
  const report = await rebuildAllTypes(f.context([app]));
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.rebuilt, ["catalog"]);
  assert.equal(fs.readFileSync(path.join(folder, "config-command.txt"), "utf8"), "build");
  assert.equal(
    fs
      .readFileSync(path.join(folder, "dist", "@mf-types.zip"))
      .subarray(4)
      .toString(),
    "local",
  );
  assert.equal(process.env[envKey], original);
});

test("bulk generation uses the selected script environment and rebuilds when it changes", async (t) => {
  const f = fixture(t);
  const { name, folder } = f.app("fixture-profile", 4653);
  const envKey = "MF_DASHBOARD_TEST_VARIANT";
  const original = process.env[envKey];
  fs.writeFileSync(
    path.join(folder, "package.json"),
    JSON.stringify({
      scripts: {
        first: `cross-env ${envKey}=first rsbuild dev --env-mode fixture.profile`,
        second: `cross-env ${envKey}=second rsbuild dev --env-mode fixture.profile`,
      },
    }),
  );
  fs.writeFileSync(
    path.join(folder, ".env.fixture.profile"),
    `${envKey}=fallback\nMF_DASHBOARD_TEST_APP=${name}\n`,
  );
  fs.writeFileSync(path.join(folder, "tsconfig.json"), '{"files":["index.ts"]}');
  fs.writeFileSync(
    path.join(folder, "rsbuild.config.cjs"),
    `const { pluginModuleFederation } = require("@module-federation/rsbuild-plugin");
    module.exports = ({ envMode }) => {
      if (envMode !== "fixture.profile") throw new Error("wrong generation profile");
      return { plugins: [pluginModuleFederation({
        name: process.env.MF_DASHBOARD_TEST_APP,
        exposes: { "./index": "./index.ts" }, dts: { generateTypes: true, consumeTypes: false }
      })] };
    };`,
  );
  installGeneratorFixture(
    folder,
    `fs.mkdirSync("dist", { recursive: true });
    fs.writeFileSync("dist/@mf-types.zip", Buffer.concat([
      Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from(process.env.${envKey})
    ]));`,
  );
  const run = (start: string) => {
    const [app] = loadKnownApps(
      [{ name: "workspace", path: folder }],
      { [name]: { path: ".", scripts: { start } } },
      "development",
    );
    assert.equal(app?.name, name);
    return rebuildAllTypes(f.context([app]));
  };
  const archive = () =>
    fs
      .readFileSync(path.join(folder, "dist", "@mf-types.zip"))
      .subarray(4)
      .toString();
  const first = await run("first");
  assert.deepEqual(first.failed, []);
  assert.deepEqual(first.rebuilt, [name]);
  assert.equal(archive(), "first");
  assert.deepEqual((await run("first")).current, [name]);

  const second = await run("second");
  assert.deepEqual(second.failed, []);
  assert.deepEqual(second.rebuilt, [name]);
  assert.equal(archive(), "second");
  assert.equal(process.env[envKey], original);
});

test("a timed-out generator ignores unrelated IPC messages and stops before the rebuild continues", async (t) => {
  const messages: string[] = [];
  const log = createLogger({ enabled: () => true, write: (_level, text) => messages.push(text) });
  const f = fixture(t);
  const stalled = f.app("catalog", 4501);
  const independent = f.app("reports", 4502);
  const consumer = f.app("shell", 4503, {
    generateTypes: false,
    consumeTypes: true,
    remotes: [remote(stalled)],
  });
  const timeoutMs = 1_500;
  const pidFile = path.join(stalled.folder, "generator-pid");
  for (const app of [stalled, independent]) {
    const hook =
      app === stalled
        ? `afterGenerate() {
             require("node:fs").writeFileSync("generator-pid", String(process.pid));
             const unrelated = { prepareMs: 999999, inputsMs: 999999, compileMs: 999999, zipMs: 999999 };
             process.send({ progress: true, timings: unrelated });
             process.send({ kind: "mf-dashboard.generation-progress", timings: {
               ...unrelated, prepareMs: "unexpected-config-text",
             } });
             process.send({ kind: "mf-dashboard.generation-progress", timings: unrelated,
               activePhase: "unknown",
             });
             return new Promise(resolve => setTimeout(resolve, 5000));
           }`
        : "";
    const configFile = path.join(app.folder, "rsbuild.config.cjs");
    fs.writeFileSync(
      configFile,
      `
const { pluginModuleFederation } = require("@module-federation/rsbuild-plugin");
module.exports = { plugins: [pluginModuleFederation({
  name: "${app.name}",
  exposes: { "./index": "./index.ts" },
  dts: { generateTypes: { compilerInstance: "tsgo", ${hook} } }
})] };
`,
    );
    app.buildConfigFile = configFile;
    installGeneratorFixture(
      app.folder,
      `
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/@mf-types.zip", Buffer.from([0x50, 0x4b, 3, 4, 1]));
`,
    );
  }

  const report = await rebuildAllTypes(
    f.context([consumer, independent, stalled], {
      log,
      progress(name) {
        if (name === independent.name) {
          const pid = Number(fs.readFileSync(pidFile, "utf8"));
          assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
        }
      },
    }),
    {
      ...unused,
      generateLocalFederatedTypes: (input, _timeout, onFailureTimings) =>
        generateLocalFederatedTypes(
          input,
          input.name === stalled.name ? timeoutMs : undefined,
          onFailureTimings,
        ),
    },
  );
  assert.deepEqual(report.failed, [
    { app: "catalog", reason: `Type generation timed out after ${timeoutMs} ms` },
  ]);
  assert.deepEqual(report.skipped, [
    { app: "shell", reason: "Dependency catalog could not be updated" },
  ]);
  assert.deepEqual(report.installed, []);
  assert.deepEqual(report.rebuilt, ["reports"]);
  assert.equal(f.confirmations.generation(stalled.name), null);
  const failure =
    messages.find(
      (line) => line.startsWith("types.rebuild.all.app") && line.includes("app=catalog "),
    ) ?? "";
  assert.match(
    failure,
    /status=failed.*prepareGenerationMs=\d+ inputsMs=\d+ compileMs=[1-9]\d* zipMs=0 queueMs=\d+ processMs=\d+/,
  );
  assert.doesNotMatch(failure, /999999|unexpected-config-text/);
});

test("phase timings stay bounded when a timed-out generator's config replaces Date.now", async (t) => {
  const { name, folder } = fixture(t).app("catalog", 4501);
  const configFile = path.join(folder, "rsbuild.config.cjs");
  fs.writeFileSync(
    configFile,
    `
const { pluginModuleFederation } = require("@module-federation/rsbuild-plugin");
Date.now = () => 0;
module.exports = { plugins: [pluginModuleFederation({
  name: "catalog", exposes: { "./index": "./index.ts" }, dts: true
})] };
`,
  );
  installGeneratorFixture(folder, "await new Promise(resolve => setTimeout(resolve, 5000));");
  const timeoutMs = 1_500;
  const captured: GenerationTimings[] = [];
  await assert.rejects(
    generateLocalFederatedTypes(
      { appDir: folder, name, configFile, envMode: "development", workspaceFingerprint: "fixture" },
      timeoutMs,
      (timings) => captured.push(timings),
    ),
    new RegExp(`Type generation timed out after ${timeoutMs} ms`),
  );
  assert.equal(captured.length, 1);
  const [timings] = captured;
  assert.ok(
    timings.compileMs > 0 && timings.compileMs <= timings.processMs,
    JSON.stringify(timings),
  );
  assert.equal(timings.zipMs, 0);
});

test("partial DTS options propagate SDK generation errors and keep explicit overrides", async (t) => {
  const f = fixture(t);
  const { name, folder } = f.app("fixture-generator", 53943);
  const configFile = path.join(folder, "rsbuild.config.cjs");
  const zipPath = path.join(folder, "dist", "@mf-types.zip");
  writeZip(zipPath, "previous declarations");
  const previousArchive = fs.readFileSync(zipPath);
  const error =
    'Declaration emit failed #TYPE-001\nargs: {"cmd":"fixture-compiler --project types.json"}';
  installGeneratorFixture(
    folder,
    `
const { abortOnError, compileInChildProcess, compilerInstance, tsConfigPath } = dtsManagerOptions.remote;
if (compilerInstance !== "fixture-compiler" || tsConfigPath !== "types.json") {
  throw new Error("configured compiler options were lost");
}
if (abortOnError && !compileInChildProcess) throw new Error(${JSON.stringify(error)});
`,
  );

  const rebuild = (flags: string) => {
    fs.writeFileSync(
      configFile,
      `
const { pluginModuleFederation } = require("@module-federation/rsbuild-plugin");
module.exports = { plugins: [pluginModuleFederation({
  name: "${name}", exposes: { "./index": "./index.ts" },
  dts: { generateTypes: { compilerInstance: "fixture-compiler", tsConfigPath: "types.json" ${flags} } }
})] };
`,
    );
    const app = readAppFolder(folder, "development");
    assert.ok(app);
    return rebuildAllTypes(f.context([app]));
  };

  const report = await rebuild("");
  assert.deepEqual(report.failed, [{ app: name, reason: error }]);
  for (const flags of [", abortOnError: false", ", compileInChildProcess: true"]) {
    const overridden = await rebuild(flags);
    assert.deepEqual(overridden.failed, [
      { app: name, reason: `generation did not write the types ZIP: ${zipPath}` },
    ]);
  }
  assert.deepEqual(fs.readFileSync(zipPath), previousArchive);
  assert.equal(f.confirmations.generation(name), null);
});

test("invalid DTS generation options reach SDK validation", async (t) => {
  const { name, folder } = fixture(t).app("fixture-invalid-dts", 53944);
  const configFile = path.join(folder, "rsbuild.config.cjs");
  installGeneratorFixture(folder, 'throw new Error("unexpected generation");');
  for (const value of ['"false"', "null", "0"]) {
    fs.writeFileSync(
      configFile,
      `
const { pluginModuleFederation } = require("@module-federation/rsbuild-plugin");
module.exports = { plugins: [pluginModuleFederation({
  name: "${name}", exposes: { "./index": "./index.ts" }, dts: { generateTypes: ${value} }
})] };
`,
    );
    await assert.rejects(
      generateLocalFederatedTypes({
        appDir: folder,
        name,
        configFile,
        envMode: "development",
        env: {},
        workspaceFingerprint: "fixture",
      }),
      /Unexpected type for mfOptions\.dts\.generateTypes/,
    );
  }
});

test("single rebuild generates in a child and checks the published ZIP using the config port", async (t) => {
  const port = 53945;
  const { name, folder } = fixture(t).app("fixture-published-dts", port);
  const configFile = path.join(folder, "rsbuild.config.cjs");
  const zipPath = path.join(folder, "dist", "@mf-types.zip");
  const bytes = [0x50, 0x4b, 3, 4, 1];
  fs.writeFileSync(
    configFile,
    `
const { pluginModuleFederation } = require("@module-federation/rsbuild-plugin");
module.exports = { server: { port: ${port} }, plugins: [pluginModuleFederation({
  name: process.env.MF_DASHBOARD_TEST_PUBLISHED_NAME, exposes: { "./index": "./index.ts" }, dts: { generateTypes: {} }
})] };
`,
  );
  installGeneratorFixture(
    folder,
    `
if (process.pid === ${process.pid}) throw new Error("generation ran in the host process");
fs.mkdirSync(${JSON.stringify(path.dirname(zipPath))}, { recursive: true });
fs.writeFileSync(${JSON.stringify(zipPath)}, Buffer.from(${JSON.stringify(bytes)}));
`,
  );
  const manifestPath = "/fixture/manifest.json";
  const origin = `http://127.0.0.1:${port}`;
  const zipUrl = `${origin}/fixture/@mf-types.zip`;
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof globalThis.fetch>[0]) => {
      if (String(input) === origin + manifestPath) {
        return Response.json({ metaData: { publicPath: "auto", types: { zip: "@mf-types.zip" } } });
      }
      assert.equal(String(input), zipUrl);
      return new Response(Uint8Array.from(bytes));
    },
  );
  assert.deepEqual(
    await generateFederatedTypes({
      appDir: folder,
      name,
      configFile,
      envMode: "development",
      env: { MF_DASHBOARD_TEST_PUBLISHED_NAME: name },
      port: null,
      manifestPath,
    }),
    { zipPath, zipHash: createHash("sha256").update(Uint8Array.from(bytes)).digest("hex"), zipUrl },
  );
  assert.equal(fetch.mock.callCount(), 2);
});

test("the built-in generator installs the archive from the active Rsbuild plugin", async (t) => {
  const f = fixture(t);
  const { folder } = f.app("catalog", 4501);
  fs.writeFileSync(path.join(folder, "tsconfig.json"), '{"files":["index.ts"]}');
  fs.writeFileSync(path.join(folder, "preview.ts"), "preview");
  const configFile = path.join(folder, "rsbuild.config.cjs");
  const config = `
const { pluginModuleFederation } = require("@module-federation/rsbuild-plugin");
const catalog = pluginModuleFederation({
  name: "catalog", exposes: { "./index": "./index.ts" }, dts: { generateTypes: true }
});
const preview = pluginModuleFederation({
  name: "preview", exposes: { "./preview": "./preview.ts" }, dts: { generateTypes: true }
});
module.exports = { server: { port: 4501 }, plugins: [catalog] };
`;
  fs.writeFileSync(configFile, config);
  installGeneratorFixture(
    folder,
    `
const [exposed] = Object.values(dtsManagerOptions.remote.moduleFederationConfig.exposes);
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/@mf-types.zip", Buffer.concat([
  Buffer.from([0x50, 0x4b, 3, 4]), fs.readFileSync(exposed)
]));
`,
  );
  const app = readAppFolder(folder, "development", "catalog");
  assert.equal(app?.name, "catalog");
  const shell = f.app("shell", 4502, {
    generateTypes: false,
    consumeTypes: true,
    remotes: [remote(app)],
  });
  const report = await rebuildAllTypes(f.context([app, shell]));
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.rebuilt, ["catalog"]);
  assert.equal(fs.readFileSync(typeFile(shell, "catalog"), "utf8"), "catalog");

  fs.writeFileSync(configFile, config.replace("plugins: [catalog]", "plugins: [preview]"));
  const changed = await rebuildAllTypes(f.context([app, shell]));
  assert.deepEqual(changed.rebuilt, []);
  assert.match(
    changed.failed[0]?.reason ?? "",
    /could not read Module Federation options for catalog/,
  );
  assert.equal(fs.readFileSync(typeFile(shell, "catalog"), "utf8"), "catalog");
});

test("the built-in generator loads a separate federation config and uses the Rsbuild output", async (t) => {
  const f = fixture(t);
  const { folder } = f.app("catalog", 4501);
  fs.writeFileSync(path.join(folder, "tsconfig.json"), '{"files":["index.ts"]}');
  fs.writeFileSync(
    path.join(folder, "module-federation.config.js"),
    `
const { createModuleFederationConfig } = require("@module-federation/rsbuild-plugin");
module.exports = createModuleFederationConfig({
  name: "catalog", exposes: { "./index": "./index.ts" }, dts: { generateTypes: true }
});
`,
  );
  const configFile = path.join(folder, "rsbuild.config.cjs");
  fs.writeFileSync(
    configFile,
    `
const { pluginModuleFederation } = require("@module-federation/rsbuild-plugin");
const federation = require("./module-federation.config");
module.exports = { output: { distPath: { root: "build/types" } }, plugins: [pluginModuleFederation(federation)] };
`,
  );
  installGeneratorFixture(
    folder,
    `
fs.mkdirSync("build/types", { recursive: true });
fs.writeFileSync("build/types/@mf-types.zip", Buffer.from([0x50, 0x4b, 3, 4, 1]));
`,
  );
  const app = readAppFolder(folder, "development", "catalog");
  assert.ok(app?.generateTypes);
  assert.equal(app.buildConfigFile, configFile);
  const report = await rebuildAllTypes(f.context([app]));
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.rebuilt, ["catalog"]);
  assert.equal(
    f.confirmations.generation("catalog")?.local?.zipPath,
    path.join(folder, "build/types/@mf-types.zip"),
  );
});

test("third-party extraction rebuilds declarations outside the compiler program", async (t) => {
  const f = fixture(t);
  const { folder } = f.app("catalog", 4501);
  const declaration = path.join(folder, "node_modules", "shared", "unused.d.ts");
  fs.mkdirSync(path.dirname(declaration), { recursive: true });
  fs.writeFileSync(declaration, "first third-party types");
  fs.writeFileSync(path.join(folder, "tsconfig.json"), '{"files":["index.ts"]}');
  fs.writeFileSync(path.join(folder, "index.ts"), "export const value = 1;");
  fs.writeFileSync(
    path.join(folder, "rsbuild.config.cjs"),
    `
const { pluginModuleFederation } = require("@module-federation/rsbuild-plugin");
module.exports = { plugins: [pluginModuleFederation({
  name: "catalog",
  exposes: { "./index": "./index.ts" },
  dts: { generateTypes: { extractThirdParty: true } }
})] };
`,
  );
  installGeneratorFixture(
    folder,
    `
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/@mf-types.zip", Buffer.concat([
  Buffer.from([0x50, 0x4b, 3, 4]), fs.readFileSync(${JSON.stringify(declaration)})
]));
`,
  );
  const app = readAppFolder(folder, "development", "catalog");
  assert.ok(app?.generateTypes);
  const context = f.context([app]);
  assert.deepEqual((await rebuildAllTypes(context)).rebuilt, ["catalog"]);
  fs.writeFileSync(declaration, "updated third-party types");
  const report = await rebuildAllTypes(context);
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.rebuilt, ["catalog"]);
  assert.equal(f.confirmations.generation("catalog")?.local, undefined);
  assert.match(
    fs.readFileSync(path.join(folder, "dist", "@mf-types.zip"), "utf8"),
    /updated third-party types/,
  );
});

test("renaming an expose invalidates the archive even when the compiler files match", async (t) => {
  const messages: string[] = [];
  const log = createLogger({ enabled: () => true, write: (_level, text) => messages.push(text) });
  const f = fixture(t);
  const { folder } = f.app("catalog", 4501);
  const exposes = path.join(folder, "exposes.json");
  const setAlias = (name: string) =>
    fs.writeFileSync(exposes, JSON.stringify({ [name]: "./index.ts" }));
  setAlias("./first");
  fs.writeFileSync(path.join(folder, "tsconfig.json"), '{"files":["index.ts"]}');
  fs.writeFileSync(path.join(folder, "index.ts"), "export const value = 1;");
  fs.writeFileSync(
    path.join(folder, "rsbuild.config.cjs"),
    `
const fs = require("node:fs");
const { pluginModuleFederation } = require("@module-federation/rsbuild-plugin");
module.exports = { plugins: [pluginModuleFederation({
  name: "catalog",
  exposes: JSON.parse(fs.readFileSync("exposes.json", "utf8")),
  dts: { generateTypes: true }
})] };
`,
  );
  installGeneratorFixture(
    folder,
    `
const [name] = Object.keys(dtsManagerOptions.remote.moduleFederationConfig.exposes);
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/@mf-types.zip", Buffer.concat([
  Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from(name)
]));
`,
  );
  const app = readAppFolder(folder, "development", "catalog");
  assert.ok(app?.hasExposes);
  const context = f.context([app], { log });
  assert.deepEqual((await rebuildAllTypes(context)).rebuilt, ["catalog"]);
  assert.deepEqual((await rebuildAllTypes(context)).current, ["catalog"]);
  const phases = messages.filter((line) => line.startsWith("types.rebuild.all.app"));
  assert.match(phases[0], /status=rebuilt.*compileMs=\d+ zipMs=\d+/);
  assert.match(phases[1], /status=cached.*compileMs=0 zipMs=\d+/);
  setAlias("./second");
  assert.deepEqual((await rebuildAllTypes(context)).rebuilt, ["catalog"]);
  assert.match(fs.readFileSync(path.join(folder, "dist", "@mf-types.zip"), "utf8"), /\.\/second/);
});

test("a custom build uses the config ZIP, honors an override and rejects an unchanged old archive", async (t) => {
  const f = fixture(t);
  const seed = f.app("catalog", 4501);
  const config = `
    import { pluginModuleFederation } from "@module-federation/rsbuild-plugin";
    export default {
      output: { distPath: { root: "ignored-for-types" } },
      plugins: [pluginModuleFederation({ name: "catalog", exposes: { "./index": "./index.ts" },
        dts: { generateTypes: { outputDir: "types-output", typesFolder: "catalog-types" } } })]
    };
  `;
  fs.writeFileSync(seed.configFile, config);
  const app = discoverSource(config, seed.configFile, {});
  assert.ok(app);
  const expected = path.join(app.folder, "types-output", "catalog-types.zip");
  let target = expected;
  let shouldWrite = true;
  const script = path.join(app.folder, "build.cjs");
  fs.writeFileSync(script, 'module.exports = "types v1"');
  const calls: string[] = [];
  const context = f.context([app], { rebuildCommand: "npm run build" });
  const io = {
    ...unused,
    async generateLocalFederatedTypes() {
      throw new Error("unexpected built-in generation");
    },
    async runRebuildCommand(_app: LocalApp, command: string) {
      calls.push(command);
      if (shouldWrite) writeZip(target, fs.readFileSync(script, "utf8"));
    },
  };
  assert.deepEqual((await rebuildAllTypes(context, io)).rebuilt, ["catalog"]);
  assert.equal(f.confirmations.generation("catalog")?.local?.zipPath, expected);
  target = path.join(app.folder, "override", "artifact.zip");
  const overridden = { ...context, zipPathOverride: () => "override/artifact.zip" };
  assert.deepEqual((await rebuildAllTypes(overridden, io)).rebuilt, ["catalog"]);
  assert.equal(f.confirmations.generation("catalog")?.local?.zipPath, target);

  fs.writeFileSync(script, 'module.exports = "types v2"');
  assert.deepEqual((await rebuildAllTypes(overridden, io)).rebuilt, ["catalog"]);
  assert.match(fs.readFileSync(target, "utf8"), /types v2/);

  shouldWrite = false;
  const failed = await rebuildAllTypes(overridden, io);
  assert.deepEqual(failed.rebuilt, []);
  assert.match(failed.failed[0]?.reason ?? "", /generation did not write the types ZIP/);
  assert.deepEqual(calls, ["npm run build", "npm run build", "npm run build", "npm run build"]);
});

test("the ZIP path follows a statically resolved bundler output", () => {
  const file = path.resolve("example", "rspack.config.ts");
  const config = `
    import { resolve } from "node:path";
    import { ModuleFederationPlugin } from "@module-federation/enhanced/rspack";
    export default {
      output: { path: resolve(__dirname, "build", "client") },
      plugins: [new ModuleFederationPlugin({ name: "catalog", dts: true, exposes: { "./index": "./index.ts" } })]
    };
  `;
  const app = discoverSource(config, file, {});
  assert.equal(
    app?.generatedZipPath,
    path.join(path.dirname(file), "build", "client", "@mf-types.zip"),
  );
  const dynamic = discoverSource(
    config.replace('resolve(__dirname, "build", "client")', "getOutputDir()"),
    file,
    {},
  );
  assert.equal(dynamic?.generatedZipPath, null);
});

test("Rebuild All logs phase timings for each microfrontend", async (t) => {
  const messages: string[] = [];
  const log = createLogger({ enabled: () => true, write: (_level, text) => messages.push(text) });
  const f = fixture(t);
  const app = f.app("catalog", 4701);
  fs.writeFileSync(path.join(app.folder, "tsconfig.json"), '{"files":["index.ts"]}');
  app.tsconfig = path.join(app.folder, "tsconfig.json");
  const timings = {
    prepareMs: 11,
    inputsMs: 22,
    compileMs: 33,
    zipMs: 7,
    queueMs: 4,
    processMs: 55,
  };
  const report = await rebuildAllTypes(
    { ...f.context([app]), log, fingerprintInputs: async () => "fixture" },
    {
      ...unused,
      async generateLocalFederatedTypes() {
        return {
          ...writeZip(path.join(app.folder, "dist", "@mf-types.zip"), "types"),
          inputsFingerprint: "fixture",
          current: false,
          timings,
        };
      },
    },
  );
  assert.deepEqual(report.rebuilt, ["catalog"]);
  const line = messages.find((message) => message.startsWith("types.rebuild.all.app")) ?? "";
  assert.match(line, /app=catalog status=rebuilt/);
  assert.match(line, /durationMs=\d+/);
  assert.match(
    line,
    /installLocalMs=\d+ installRemoteMs=\d+ prepareMs=\d+ generateMs=\d+ verifyMs=\d+/,
  );
  assert.match(
    line,
    /prepareGenerationMs=11 inputsMs=22 compileMs=33 zipMs=7 queueMs=4 processMs=55/,
  );
  const plan = messages.find((message) => message.startsWith("types.rebuild.all.plan")) ?? "";
  assert.match(plan, /apps=1/);
  assert.match(plan, /durationMs=\d+/);

  messages.length = 0;
  const failed = await rebuildAllTypes(
    { ...f.context([app]), log, fingerprintInputs: async () => "fixture" },
    {
      ...unused,
      async generateLocalFederatedTypes() {
        throw new Error("generation failed");
      },
    },
  );
  assert.equal(failed.rebuilt.length, 0);
  assert.equal(failed.failed.length, 1);
  const failure = messages.find((message) => message.startsWith("types.rebuild.all.app"));
  assert.match(failure ?? "", /app=catalog status=failed/);
  assert.match(failure ?? "", /generateMs=\d+/);
  assert.match(
    messages.find((message) => message.startsWith("types.rebuild.all.failed")) ?? "",
    /app=catalog/,
  );
});
