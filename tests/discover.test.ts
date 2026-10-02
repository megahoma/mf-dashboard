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
