import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverSource, scanWorkspace } from "../src/entities/microfrontend/index.ts";

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
