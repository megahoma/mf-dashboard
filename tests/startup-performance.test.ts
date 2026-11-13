import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { ConfigurationChangeEvent, ExtensionContext } from "vscode";
import * as stub from "./support/vscode.ts";
import { defaultWorkspaceSettings } from "../src/features/init-settings/lib/defaults.ts";
import { scanWorkspace, createProbeBook } from "../src/entities/microfrontend/index.ts";
import { DashboardSession } from "../src/widgets/mf-dashboard-tree/models/session.ts";
import { loadKnownApps } from "../src/widgets/mf-dashboard-tree/lib/known-apps.ts";
import type { DashboardSettings } from "../src/widgets/mf-dashboard-tree/models/session-types.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "vscode")
      return { url: new URL("./support/vscode.ts", import.meta.url).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { activate } = await import("../src/app/extension.ts");

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-startup-performance-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "unrelated", "nested"), { recursive: true });
  const writeApp = (name: string) => {
    const folder = path.join(root, name);
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, "module-federation.config.ts");
    fs.writeFileSync(
      file,
      `export default { name: ${JSON.stringify(name)}, manifest: true, dts: false };\n`,
    );
    return file;
  };
  return { root, writeApp };
}

async function start(
  t: TestContext,
  root: string,
  initial: Record<string, unknown>,
  onWrite?: (key: string) => void,
  emitConfigurationEvents = false,
) {
  const values = new Map(Object.entries(initial));
  const writes: string[] = [];
  const defaults = defaultWorkspaceSettings() as unknown as Record<string, unknown>;
  const subscriptions: { dispose(): unknown }[] = [];
  const changes = new stub.EventEmitter<ConfigurationChangeEvent>();
  t.mock.method(
    stub.workspace,
    "onDidChangeConfiguration",
    changes.event as unknown as typeof stub.workspace.onDidChangeConfiguration,
  );
  t.after(() => {
    for (const subscription of subscriptions.reverse()) subscription.dispose();
  });
  const workspace = stub.workspace as typeof stub.workspace & {
    workspaceFolders?: { name: string; uri: stub.Uri }[];
  };
  const previousFolders = workspace.workspaceFolders;
  workspace.workspaceFolders = [{ name: "workspace", uri: stub.Uri.file(root) }];
  t.after(() => {
    workspace.workspaceFolders = previousFolders;
  });
  t.mock.method(stub.workspace, "getConfiguration", ((section?: string) => ({
    get(key: string) {
      const full = section ? `${section}.${key}` : key;
      return values.get(full) ?? defaults[full];
    },
    inspect(key: string) {
      const full = section ? `${section}.${key}` : key;
      return values.has(full) ? { workspaceValue: values.get(full) } : undefined;
    },
    async update(key: string, value: unknown) {
      const full = section ? `${section}.${key}` : key;
      writes.push(full);
      values.set(full, value);
      if (emitConfigurationEvents)
        changes.fire({ affectsConfiguration: (key) => key === full } as ConfigurationChangeEvent);
      onWrite?.(full);
    },
  })) as unknown as typeof stub.workspace.getConfiguration);
  let session: DashboardSession | undefined;
  const createTreeView = stub.window.createTreeView;
  t.mock.method(
    stub.window,
    "createTreeView",
    (id: string, options: { treeDataProvider: unknown }) => {
      session = (options.treeDataProvider as { session: DashboardSession }).session;
      return createTreeView(id, options);
    },
  );
  const firstChannel = stub.outputChannels.length;
  activate({
    subscriptions,
    extensionUri: stub.Uri.file(fileURLToPath(new URL("..", import.meta.url))),
    extension: { packageJSON: { version: "test-version" } },
    extensionMode: 2,
    workspaceState: { get: () => undefined, update: async () => {} },
  } as unknown as ExtensionContext);
  const channel = stub.outputChannels[firstChannel];
  for (
    let turn = 0;
    turn < 100 &&
    !channel.messages.some((message) => /startup.completed|startup.failed/.test(message));
    turn++
  )
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(
    channel.messages.some((message) => message.includes("refresh.completed")),
    channel.messages.join("\n"),
  );
  assert.ok(session);
  return { session, values, writes, channel };
}

test("startup diagnostics expose settings writes and preserve all configuration-triggered refreshes", async (t) => {
  const { root, writeApp } = fixture(t);
  writeApp("shell");
  writeApp("widget");
  const { channel, writes } = await start(t, root, {}, undefined, true);
  for (let turn = 0; turn < 20; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
  const refreshes = () => channel.messages.filter((text) => text.startsWith("refresh.started"));
  assert.equal(writes.length, Object.keys(defaultWorkspaceSettings()).length + 1);
  assert.equal(refreshes().length, 8, channel.messages.join("\n"));
  assert.ok(channel.messages.some((text) => text.startsWith("settings.seed.completed")));
  assert.ok(channel.messages.some((text) => text.startsWith("discovery.scan.completed")));
  assert.ok(channel.messages.some((text) => text.startsWith("startup.completed")));
});

for (const seeded of [false, true]) {
  test(`configured startup skips workspace discovery with defaults ${seeded ? "saved" : "missing"}`, async (t) => {
    const { root, writeApp } = fixture(t);
    writeApp("configured");
    writeApp("not-yet-discovered");
    const readdir = t.mock.method(fs, "readdirSync");
    const initial = {
      ...(seeded ? defaultWorkspaceSettings() : {}),
      "mf-dashboard.apps": { configured: { path: "configured" } },
    };
    const { session, writes } = await start(t, root, initial);
    assert.deepEqual(
      session.loaded.map((app) => app.name),
      ["configured"],
    );
    assert.equal(readdir.mock.calls.filter((call) => String(call.arguments[0]) === root).length, 0);
    assert.equal(
      readdir.mock.calls.filter((call) => String(call.arguments[0]).includes("unrelated")).length,
      0,
    );
    assert.equal(writes.length, seeded ? 0 : Object.keys(defaultWorkspaceSettings()).length);
    await session.discover();
    assert.deepEqual(session.loaded.map((app) => app.name).sort(), [
      "configured",
      "not-yet-discovered",
    ]);
  });
}

test("first startup shares one workspace scan and config parse across seeding, discovery and refresh", async (t) => {
  const { root, writeApp } = fixture(t);
  const config = writeApp("discovered");
  const readdir = t.mock.method(fs, "readdirSync");
  const readFile = t.mock.method(fs, "readFileSync");
  const { session, values } = await start(t, root, {});
  assert.deepEqual(
    session.loaded.map((app) => app.name),
    ["discovered"],
  );
  assert.equal(readdir.mock.calls.filter((call) => String(call.arguments[0]) === root).length, 1);
  assert.equal(
    readFile.mock.calls.filter((call) => String(call.arguments[0]) === config).length,
    1,
  );
  assert.deepEqual(values.get("mf-dashboard.apps"), {
    discovered: {
      path: "discovered",
    },
  });
  writeApp("new-config");
  await session.discover();
  assert.deepEqual(session.loaded.map((app) => app.name).sort(), ["discovered", "new-config"]);
});

for (const apps of [undefined, {}]) {
  test(`ordinary workspace remains unchanged with apps ${apps === undefined ? "undefined" : "empty"}`, async (t) => {
    const { root } = fixture(t);
    const readdir = t.mock.method(fs, "readdirSync");
    const { session, writes } = await start(
      t,
      root,
      apps === undefined ? {} : { "mf-dashboard.apps": apps },
    );
    assert.deepEqual(session.loaded, []);
    assert.deepEqual(writes, []);
    assert.equal(
      readdir.mock.calls.filter((call) => String(call.arguments[0]) === root).length,
      apps === undefined ? 1 : 0,
    );
  });
}

test("prepared discovery invalidates changed settings and config before reuse", async (t) => {
  const { root, writeApp } = fixture(t);
  const config = writeApp("before");
  let scans = 0;
  const current: DashboardSettings = {
    apps: undefined,
    envMode: "development",
    ignorePaths: [],
    extraManifestUrls: [],
    structure: "tree",
  };
  const session = new DashboardSession(
    {
      readSettings: () => current,
      writeApps(apps) {
        current.apps = apps;
      },
      scan(root, options) {
        scans++;
        return scanWorkspace(root, options);
      },
      loadKnown: loadKnownApps,
      roots: () => [{ name: "workspace", path: root }],
      async probe() {},
    },
    createProbeBook(),
  );
  session.prepareDiscovery();
  fs.writeFileSync(config, 'export default { name: "changed-longer", manifest: true };\n');
  await session.discover();
  assert.equal(scans, 2);
  assert.deepEqual(
    session.loaded.map((app) => app.name),
    ["changed-longer"],
  );
  session.prepareDiscovery();
  current.envMode = "production";
  current.ignorePaths = ["unrelated"];
  await session.discover();
  assert.equal(scans, 4);
});

test("initial discovery uses the configured start script and new entries inherit it", async (t) => {
  const { root } = fixture(t);
  const folder = path.join(root, "fixture-app");
  fs.mkdirSync(path.join(folder, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(folder, "package.json"),
    '{"scripts":{"serve":"rsbuild dev --config config/local.ts"}}',
  );
  fs.writeFileSync(
    path.join(folder, "config", "local.ts"),
    'export default { server: { port: 4651 }, plugins: [pluginModuleFederation({ name: "fixture-app" })] };',
  );
  const current: DashboardSettings = {
    apps: undefined,
    envMode: "development",
    startScript: "dev",
    ignorePaths: [],
    extraManifestUrls: [],
    structure: "tree",
  };
  const session = new DashboardSession(
    {
      readSettings: () => current,
      writeApps(apps) {
        current.apps = apps;
      },
      scan: scanWorkspace,
      loadKnown: loadKnownApps,
      roots: () => [{ name: "workspace", path: root }],
      async probe() {},
    },
    createProbeBook(),
  );
  assert.deepEqual(session.prepareDiscovery(), []);
  current.startScript = "serve";
  await session.discover();
  assert.deepEqual(current.apps, { "fixture-app": { path: "fixture-app" } });
  assert.equal(session.loaded[0]?.port, 4651);
  await session.refresh();
  assert.equal(session.loaded[0]?.port, 4651);
});

test("an imported intermediate changed while default settings are written invalidates startup discovery", async (t) => {
  const { root, writeApp } = fixture(t);
  const config = writeApp("app");
  const folder = path.dirname(config);
  const helper = path.join(folder, "name.ts");
  fs.writeFileSync(
    config,
    'import { name } from "./bridge"; export default { name, manifest: true, dts: false };\n',
  );
  fs.writeFileSync(path.join(folder, "bridge.ts"), 'export { name } from "./name";\n');
  fs.writeFileSync(helper, 'export const name = "before";\n');
  let changed = false;
  const { session, values } = await start(t, root, {}, () => {
    if (changed) return;
    changed = true;
    fs.writeFileSync(helper, 'export const name = "after-change";\n');
  });
  assert.equal(changed, true);
  assert.deepEqual(
    session.loaded.map((app) => app.name),
    ["after-change"],
  );
  assert.deepEqual(Object.keys(values.get("mf-dashboard.apps") as object), ["after-change"]);
});

test("an imported value changed during the apps write is reread before the first probe", async (t) => {
  const { root, writeApp } = fixture(t);
  const config = writeApp("app");
  const helper = path.join(path.dirname(config), "port.ts");
  fs.writeFileSync(
    config,
    'import { port } from "./port"; export default { name: "app", server: { port }, manifest: true };\n',
  );
  fs.writeFileSync(helper, "export const port = 4100;\n");
  const current: DashboardSettings = {
    apps: undefined,
    envMode: "development",
    ignorePaths: [],
    extraManifestUrls: [],
    structure: "tree",
  };
  let probedPort: number | null = null;
  const session = new DashboardSession(
    {
      readSettings: () => current,
      async writeApps(apps) {
        current.apps = apps;
        await Promise.resolve();
        fs.writeFileSync(helper, "export const port = 42001;\n");
      },
      scan: scanWorkspace,
      loadKnown: loadKnownApps,
      roots: () => [{ name: "workspace", path: root }],
      async probe(_book, input) {
        probedPort = input.apps[0].port;
      },
    },
    createProbeBook(),
  );
  session.prepareDiscovery();
  await session.discover();
  assert.equal(probedPort, 42001);
});

for (const existingDirectory of [false, true]) {
  test(`a config added ${existingDirectory ? "in an existing directory" : "with a new app directory"} during settings writes invalidates startup discovery`, async (t) => {
    const { root, writeApp } = fixture(t);
    writeApp("first");
    if (existingDirectory) fs.mkdirSync(path.join(root, "second"));
    let changed = false;
    const { session, values } = await start(t, root, {}, () => {
      if (changed) return;
      changed = true;
      writeApp("second");
    });
    assert.equal(changed, true);
    assert.deepEqual(session.loaded.map((app) => app.name).sort(), ["first", "second"]);
    assert.deepEqual(Object.keys(values.get("mf-dashboard.apps") as object).sort(), [
      "first",
      "second",
    ]);
  });
}

test("changes inside ignored directories do not invalidate the prepared discovery", async (t) => {
  const { root, writeApp } = fixture(t);
  writeApp("included");
  const ignored = path.join(root, "ignored");
  fs.mkdirSync(ignored);
  const current: DashboardSettings = {
    apps: undefined,
    envMode: "development",
    ignorePaths: ["ignored"],
    extraManifestUrls: [],
    structure: "tree",
  };
  let scans = 0;
  const session = new DashboardSession(
    {
      readSettings: () => current,
      writeApps(apps) {
        current.apps = apps;
      },
      scan(root, options) {
        scans++;
        return scanWorkspace(root, options);
      },
      loadKnown: loadKnownApps,
      roots: () => [{ name: "workspace", path: root }],
      async probe() {},
    },
    createProbeBook(),
  );
  session.prepareDiscovery();
  fs.writeFileSync(
    path.join(ignored, "module-federation.config.ts"),
    'export default { name: "ignored" };\n',
  );
  const readdir = t.mock.method(fs, "readdirSync");
  await session.discover();
  assert.equal(scans, 1);
  assert.equal(readdir.mock.calls.filter((call) => String(call.arguments[0]) === root).length, 0);
  assert.equal(
    readdir.mock.calls.filter((call) => String(call.arguments[0]) === ignored).length,
    0,
  );
  assert.deepEqual(
    session.loaded.map((app) => app.name),
    ["included"],
  );
});
