import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  createConfirmationStore,
  sourceIdentity,
  treeFingerprint,
} from "../src/entities/federated-types/index.ts";
import {
  createProbeBook,
  discoverSource,
  putLinkResult,
  readAppFolder,
  type LocalApp,
} from "../src/entities/microfrontend/index.ts";
import { verifyTypeInstalls } from "../src/features/observe-types/verify.ts";
import { rebuildAllTypes, type RebuildAllContext } from "../src/features/rebuild-types/all.ts";
import {
  rebuildLocalArchive,
  type LocalGeneratedZip,
  type LocalGenerationInput,
} from "../src/features/rebuild-types/generate.mts";
import { installRemoteTypes } from "../src/features/refetch-types/remote.ts";
import { localApp } from "./support/app.ts";

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
      "exports.pluginModuleFederation = options => globalThis.__mfCaptured = options;",
    "jiti/index.js": "exports.createJiti = () => file => require(file);",
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
exports.normalizeDtsOptions = options => options.dts.generateTypes ? options.dts : false;
exports.normalizeGenerateTypesOptions = ({ context, pluginOptions }) => ({
  remote: { context, moduleFederationConfig: pluginOptions, ...pluginOptions.dts.generateTypes }
});
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

test("offline workspace rebuild installs dependencies before generation and visits a shared producer once", async (t) => {
  const f = fixture(t);
  const leaf = f.app("leaf", 4501);
  const middle = f.app("middle", 4502, { consumeTypes: true, remotes: [remote(leaf)] });
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
      const input = name === "middle" ? fs.readFileSync(typeFile(middle, "leaf"), "utf8") : "";
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
    remotes: [{ alias: "unknown", name: healthy.name, url: null }],
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
  const archive = writeZip(path.join(shell.folder, "staging.zip"), "staging types");
  const bytes = fs.readFileSync(archive.zipPath);
  const link = { consumer: shell.name, alias: "catalog", remoteName: catalog.name, url };
  const book = createProbeBook();
  putLinkResult(book, {
    link,
    manifestReachable: true,
    buildVersion: null,
    zipUrl,
    zipHash: archive.zipHash,
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
  const url = "https://staging.example/catalog/mf-manifest.json";
  const shell = f.app("shell", 4502, {
    consumeTypes: true,
    remotes: [{ alias: "catalog", name: "catalog", url }],
  });
  const file = typeFile(shell, "catalog");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "local-only types");
  const link = { consumer: shell.name, alias: "catalog", remoteName: "catalog", url };
  f.confirmations.saveInstall(link, treeFingerprint(path.dirname(file)), "local-zip", false);
  const confirmations = createConfirmationStore(f.confirmations.snapshot());
  const requests: string[] = [];
  const context = f.context([shell], { confirmations });
  const io: NonNullable<Parameters<typeof rebuildAllTypes>[1]> = {
    ...unused,
    async installRemoteTypes(_app, _dependency, manifestUrl) {
      requests.push(manifestUrl);
      fs.writeFileSync(file, "staging types");
      return { zipHash: "staging-zip", filesFingerprint: treeFingerprint(path.dirname(file)) };
    },
    generateLocalFederatedTypes: mockGeneration((appDir) => {
      return writeZip(path.join(appDir, "dist", "@mf-types.zip"), fs.readFileSync(file, "utf8"));
    }),
  };
  const report = await rebuildAllTypes(context, io);
  assert.deepEqual(requests, [url]);
  assert.deepEqual(report.rebuilt, ["shell"]);
  assert.match(
    fs.readFileSync(path.join(shell.folder, "dist", "@mf-types.zip"), "utf8"),
    /staging types/,
  );
  assert.equal(confirmations.install(link)?.fromManifest, true);
  assert.deepEqual((await rebuildAllTypes(context, io)).current, ["shell"]);
  assert.deepEqual(requests, [url]);
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

test("the built-in generator runs in the app directory with the discovery environment", async (t) => {
  const f = fixture(t);
  const { folder } = f.app("catalog", 4501);
  const envKey = "MF_DASHBOARD_TEST_GENERATION_MODE";
  const original = process.env[envKey];
  fs.writeFileSync(path.join(folder, ".env.development"), `${envKey}=base\n`);
  fs.writeFileSync(path.join(folder, ".env.development.local"), `${envKey}=local\n`);
  fs.writeFileSync(path.join(folder, "tsconfig.json"), '{"files":["index.ts"]}');
  fs.writeFileSync(
    path.join(folder, "rsbuild.config.cjs"),
    `
const { pluginModuleFederation } = require("@module-federation/rsbuild-plugin");
module.exports = { plugins: [pluginModuleFederation({
  name: "catalog",
  exposes: { "./index": "./index.ts" },
  dts: { generateTypes: process.env.${envKey} === "local" ? true : false }
})] };
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
  const report = await rebuildAllTypes(f.context([app]));
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.rebuilt, ["catalog"]);
  assert.equal(
    fs
      .readFileSync(path.join(folder, "dist", "@mf-types.zip"))
      .subarray(4)
      .toString(),
    "local",
  );
  assert.equal(process.env[envKey], original);
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
  const context = f.context([app]);
  assert.deepEqual((await rebuildAllTypes(context)).rebuilt, ["catalog"]);
  assert.deepEqual((await rebuildAllTypes(context)).current, ["catalog"]);
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
