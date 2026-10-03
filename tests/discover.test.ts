import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverSource, scanWorkspace } from "../src/entities/microfrontend/index.ts";

test("invalid server ports are ignored", () => {
  for (const port of [0, 65536, 1.5]) {
    const source = `export default { server: { port: ${port} }, plugins: [pluginModuleFederation({ name: "app" })] };`;
    assert.equal(discoverSource(source, "/widget-1/rsbuild.config.ts", {})?.port, null);
  }
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
    new URL("../src/entities/microfrontend/discover.ts", import.meta.url),
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

test("discovery follows local reexports without executing configs and combines a separate server", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-import-scan-"));
  try {
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    fs.writeFileSync(
      path.join(root, "options.ts"),
      `
      throw new Error("configuration must not execute");
      export function federation() { return { name: "shell", manifest: true, dts: true }; }
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
      "export default { server: { port: 4100 } };",
    );
    const found = scanWorkspace(root);
    assert.equal(found.shell?.name, "shell");
    assert.equal(found.shell?.port, 4100);
    assert.equal(found.shell?.configFile, path.join(root, "options.ts"));
    assert.equal(found.shell?.generateTypes, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
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
