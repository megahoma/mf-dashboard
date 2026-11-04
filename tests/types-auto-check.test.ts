import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { registerHooks } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import * as vscode from "./support/vscode.ts";
import {
  createConfirmationStore,
  readInstalledEvidence,
} from "../src/entities/federated-types/index.ts";
import { appProbeId } from "../src/entities/microfrontend/index.ts";
import { terms } from "../src/shared/config/index.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "vscode")
      return { url: new URL("./support/vscode.ts", import.meta.url).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { MfDashboardProvider } = await import("../src/widgets/mf-dashboard-tree/provider.ts");

function fixture(t: TestContext, automatic = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mf-manual-check-")));
  const options = { automatic, portOpen: true, version: "first" };
  const definitions = [
    {
      name: "studio",
      port: 4500,
      remotes: {
        paint: "palette@http://localhost:4501/mf-manifest.json",
        track: "timeline@http://localhost:4502/mf-manifest.json",
      },
    },
    {
      name: "editor",
      port: 4503,
      remotes: { paint: "palette@http://localhost:4501/mf-manifest.json" },
    },
    { name: "palette", port: 4501, remotes: {} },
    { name: "timeline", port: 4502, remotes: {} },
  ];
  const archive = new Uint8Array([7, 8, 9]);
  const zipHash = createHash("sha256").update(archive).digest("hex");
  const store = createConfirmationStore();
  const typesFile = (name: string, alias: string) =>
    path.join(root, name, "@mf-types", alias, "index.d.ts");
  const sourceFile = (name: string) => path.join(root, name, "src", "component.ts");
  for (const definition of definitions) {
    const dir = path.join(root, definition.name);
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(sourceFile(definition.name), "export const revision = 1;");
    fs.writeFileSync(
      path.join(dir, "rsbuild.config.ts"),
      `export default defineConfig({server:{port:${definition.port}},plugins:[pluginModuleFederation(${JSON.stringify({ name: definition.name, dts: true, manifest: true, remotes: definition.remotes })})]});`,
    );
    for (const [alias, value] of Object.entries(definition.remotes)) {
      const file = typesFile(definition.name, alias);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "export type Revision = 1;");
      const [remoteName, ...url] = value.split("@");
      store.saveInstall(
        { consumer: definition.name, alias, remoteName, url: url.join("@") },
        readInstalledEvidence(path.dirname(file)).filesFingerprint!,
        zipHash,
      );
    }
  }
  Object.assign(vscode.workspace, {
    workspaceFolders: [{ name: "example", uri: vscode.Uri.file(root) }],
  });
  t.mock.method(vscode.workspace, "getConfiguration", () => ({
    async update() {},
    inspect: () => ({
      workspaceValue: Object.fromEntries(
        definitions.map((definition) => [definition.name, { path: definition.name }]),
      ),
    }),
    get: <T>(key: string): T | undefined =>
      (key === "types.autoCheck" ? options.automatic : key === "structure" ? "tree" : undefined) as
        T | undefined,
  }));
  t.mock.method(net, "connect", () => {
    const socket = Object.assign(new EventEmitter(), { setTimeout() {}, destroy() {} });
    queueMicrotask(() => socket.emit(options.portOpen ? "connect" : "error", new Error("closed")));
    return socket as unknown as net.Socket;
  });
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith(".json"))
      return Response.json({
        metaData: {
          publicPath: `${new URL(url).origin}/`,
          types: { zip: "types.zip" },
          buildInfo: { buildVersion: options.version },
        },
      });
    return new Response(archive, {
      headers: { "last-modified": new Date(Date.now() + 60_000).toUTCString() },
    });
  });
  const reads = t.mock.method(fs, "readFileSync");
  const scans = t.mock.method(fs, "readdirSync");
  const sourceReads = (name: string) =>
    reads.mock.calls.filter((call) => String(call.arguments[0]) === sourceFile(name)).length;
  const typeReads = (name: string, alias: string) =>
    reads.mock.calls.filter((call) => String(call.arguments[0]) === typesFile(name, alias)).length;
  const typeScans = (name: string, alias: string) =>
    scans.mock.calls.filter(
      (call) => String(call.arguments[0]) === path.dirname(typesFile(name, alias)),
    ).length;
  const heavyScans = () =>
    scans.mock.calls.filter((call) =>
      /[/\\](?:src|@mf-types)(?:[/\\]|$)/.test(String(call.arguments[0])),
    ).length;
  const provider = new MfDashboardProvider(() => terms, store);
  t.after(() => {
    provider.dispose();
    Reflect.deleteProperty(vscode.workspace, "workspaceFolders");
    fs.rmSync(root, { recursive: true, force: true });
  });
  const row = (name = "studio") => provider.getChildren().find((node) => node.name === name)!;
  const zipRequests = () => requests.filter((url) => url.endsWith(".zip"));
  return {
    root,
    options,
    provider,
    requests,
    row,
    sourceReads,
    typeReads,
    typeScans,
    heavyScans,
    zipRequests,
    sourceFile,
    typesFile,
  };
}

test("autoCheck false keeps ports and manifests live without type scans, ZIP requests or save checks", async (t) => {
  const f = fixture(t);
  await f.provider.refresh("startup");
  const before = f.requests.length;
  assert.ok(before > 0);
  assert.ok(f.row().children[0].description.includes(terms.typesUnchecked));
  assert.ok(f.provider.getTreeItem(f.row()).contextValue?.includes("check-types"));
  await f.provider.fileSaved(f.sourceFile("palette"));
  await f.provider.refresh("timer");
  f.options.version = "second";
  await f.provider.refresh("settings");
  assert.equal(f.provider.session.book.apps.get(appProbeId("palette"))?.buildVersion, "second");
  f.options.portOpen = false;
  await f.provider.refresh("timer");
  assert.equal(f.provider.session.book.apps.get(appProbeId("palette"))?.portOpen, false);
  assert.ok(f.requests.length > before);
  assert.deepEqual(f.zipRequests(), []);
  assert.equal(f.heavyScans(), 0);
  assert.equal(f.sourceReads("palette"), 0);
  assert.equal(f.typeReads("studio", "paint"), 0);
});

test("manual checks inspect only the selected link or consumer and retain the dated snapshot", async (t) => {
  const f = fixture(t);
  await f.provider.refresh("startup");
  const selected = f.row().children.find((node) => node.name === "palette")!;
  await f.provider.checkTypes(selected);
  assert.ok(f.zipRequests().length > 0);
  assert.deepEqual([...new Set(f.zipRequests().map((url) => new URL(url).port))], ["4501"]);
  assert.ok(f.sourceReads("palette") > 0);
  assert.equal(f.sourceReads("timeline"), 0);
  assert.ok(f.typeScans("studio", "paint") > 0);
  assert.equal(f.typeScans("studio", "track"), 0);
  assert.equal(f.typeScans("editor", "paint"), 0);
  const tooltip = f.row().children.find((node) => node.name === "palette")!.tooltip;
  assert.ok(tooltip.includes(terms.typesCheckedAt));
  const counts = [
    f.sourceReads("palette"),
    f.typeReads("studio", "paint"),
    f.heavyScans(),
    f.zipRequests().length,
  ];
  fs.writeFileSync(f.sourceFile("palette"), "export const revision = 22;");
  fs.writeFileSync(f.typesFile("studio", "paint"), "export type Revision = 22;");
  await f.provider.fileSaved(f.sourceFile("palette"));
  await f.provider.refresh("timer");
  assert.equal(f.row().children.find((node) => node.name === "palette")!.tooltip, tooltip);
  assert.deepEqual(
    [
      f.sourceReads("palette"),
      f.typeReads("studio", "paint"),
      f.heavyScans(),
      f.zipRequests().length,
    ],
    counts,
  );
  await f.provider.checkTypes(f.row());
  assert.ok(f.sourceReads("timeline") > 0);
  assert.ok(f.typeScans("studio", "track") > 0);
  assert.equal(f.typeScans("editor", "paint"), 0);
  const checked = f.row().children.find((node) => node.name === "palette")!;
  assert.equal(checked.kind, "unfetched");
  const requests = f.requests.length;
  await f.provider.checkTypes({ ...f.row(), id: "app:not-configured" });
  assert.equal(f.requests.length, requests);
  await f.provider.refresh();
  assert.ok(
    f.typeScans("editor", "paint") > 0,
    "the main Refresh command explicitly checks all types",
  );
});

test("enabling autoCheck hides the button and disabling it cancels pending source checks", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t, true);
  await f.provider.refresh("startup");
  assert.equal(f.provider.getTreeItem(f.row()).contextValue?.includes("check-types"), false);
  assert.ok(f.zipRequests().length > 0);
  await f.provider.fileSaved(f.sourceFile("palette"));
  f.options.automatic = false;
  f.provider.typesSettingsChanged();
  assert.ok(f.provider.getTreeItem(f.row()).contextValue?.includes("check-types"));
  const scans = f.heavyScans();
  t.mock.timers.tick(15_000);
  f.provider.getChildren();
  assert.equal(f.heavyScans(), scans);
  const downloads = f.zipRequests().length;
  await f.provider.refresh("timer");
  assert.equal(f.zipRequests().length, downloads);
  f.options.automatic = true;
  f.provider.typesSettingsChanged();
  await f.provider.refresh("settings");
  assert.ok(f.zipRequests().length > downloads);
  assert.equal(f.provider.getTreeItem(f.row()).contextValue?.includes("check-types"), false);
});

test("manual targets use current config URLs and include newly added consumer remotes", async (t) => {
  const f = fixture(t);
  await f.provider.refresh("startup");
  const link = f.row().children.find((node) => node.name === "palette")!;
  const config = path.join(f.root, "studio", "rsbuild.config.ts");
  fs.writeFileSync(
    config,
    fs.readFileSync(config, "utf8").replace("localhost:4501", "localhost:45111"),
  );
  await f.provider.checkTypes(link);
  assert.ok(f.zipRequests().includes("http://localhost:45111/types.zip"));
  const app = f.row();
  fs.writeFileSync(
    config,
    fs
      .readFileSync(config, "utf8")
      .replace(
        '"remotes":{',
        '"remotes":{"preview":"palette@http://localhost:45112/mf-manifest.json",',
      ),
  );
  await f.provider.checkTypes(app);
  assert.ok(f.zipRequests().includes("http://localhost:45112/types.zip"));
});

test("a failed manual refresh retains the previous type result and check time", async (t) => {
  const f = fixture(t);
  await f.provider.refresh("startup");
  await f.provider.checkTypes(f.row().children.find((node) => node.name === "palette")!);
  const previous = f.row().children.find((node) => node.name === "palette")!;
  const config = path.join(f.root, "editor", "rsbuild.config.ts");
  fs.writeFileSync(
    config,
    fs.readFileSync(config, "utf8").replace('"name":"editor"', '"name":"studio","extra":true'),
  );
  await assert.rejects(() => f.provider.checkTypes(f.row()), /duplicate federation name/);
  assert.deepEqual(
    f.row().children.find((node) => node.name === "palette"),
    previous,
  );
});

test("the setting and manual command are localized and the button is conditional on false", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const setting = pkg.contributes.configuration.properties["mf-dashboard.types.autoCheck"];
  assert.equal(setting.default, true);
  assert.equal(setting.type, "boolean");
  const button = pkg.contributes.menus["view/item/context"].find(
    (item: { command: string }) => item.command === "mf-dashboard.checkTypes",
  );
  assert.match(button.when, /config\.mf-dashboard\.types\.autoCheck == false/);
  assert.match(button.when, /check-types/);
  for (const file of ["package.nls.json", "package.nls.ru.json"]) {
    const strings = JSON.parse(fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
    assert.ok(strings["configuration.types.autoCheck"]);
    assert.ok(strings["command.checkTypes"]);
  }
});
