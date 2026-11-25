import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { ConfigurationChangeEvent, ExtensionContext } from "vscode";
import { developmentFederationConfig } from "./support/app.ts";
import * as stub from "./support/vscode.ts";
import { defaultWorkspaceSettings } from "../src/features/init-settings/lib/defaults.ts";
import {
  scanWorkspace,
  prepareWorkspaceScan,
  createProbeBook,
} from "../src/entities/microfrontend/index.ts";
import { DashboardSession } from "../src/widgets/mf-dashboard-tree/models/session.ts";
import {
  createDiscoveryLookups,
  loadKnownApps,
} from "../src/widgets/mf-dashboard-tree/lib/known-apps.ts";
import { KnownAppsWorker } from "../src/widgets/mf-dashboard-tree/lib/known-apps-worker.mts";
import { noLog } from "../src/shared/config/logging.ts";
import { createLogger } from "../src/shared/lib/logging.ts";
import type { DashboardSettings } from "../src/widgets/mf-dashboard-tree/models/session-types.ts";
import type { TypesBuildView } from "../src/app/lib/types-build-view.ts";
import type { MfDashboardProvider } from "../src/widgets/mf-dashboard-tree/index.ts";

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
  expectedRefresh = "refresh.completed",
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
  let dashboard: MfDashboardProvider | undefined;
  let typesView: TypesBuildView | undefined;
  const createTreeView = stub.window.createTreeView;
  t.mock.method(
    stub.window,
    "createTreeView",
    (id: string, options: { treeDataProvider: unknown }) => {
      if (id === "mf-dashboard") {
        dashboard = options.treeDataProvider as MfDashboardProvider;
        session = dashboard.session;
      }
      if (id === "mf-dashboard.typesBuild") typesView = options.treeDataProvider as TypesBuildView;
      return createTreeView(id, options);
    },
  );
  const firstChannel = stub.outputChannels.length;
  const state = new Map<string, unknown>();
  activate({
    subscriptions,
    extensionUri: stub.Uri.file(fileURLToPath(new URL("..", import.meta.url))),
    extension: { packageJSON: { version: "test-version" } },
    extensionMode: 2,
    workspaceState: {
      get: (key: string) => state.get(key),
      async update(key: string, value: unknown) {
        state.set(key, value);
      },
    },
  } as unknown as ExtensionContext);
  const channel = stub.outputChannels[firstChannel];
  for (
    const deadline = Date.now() + 5000;
    Date.now() < deadline &&
    !channel.messages.some((message) => /startup.completed|startup.failed/.test(message));
  )
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  assert.ok(
    channel.messages.some((message) => message.includes(expectedRefresh)),
    channel.messages.join("\n"),
  );
  assert.ok(session);
  assert.ok(dashboard);
  assert.ok(typesView);
  return { session, values, writes, channel, changes, typesView, state, dashboard };
}

test("discovery shows progress and enables type builds only after apps load", async (t) => {
  const { root, writeApp } = fixture(t);
  const context = t.mock.method(stub.commands, "executeCommand");
  const progress = t.mock.method(stub.window, "withProgress");
  const { session } = await start(t, root, {
    ...defaultWorkspaceSettings(),
    "mf-dashboard.apps": {},
  });
  const run = (name: string, ...args: unknown[]) =>
    stub.registeredCommands.get(`mf-dashboard.${name}`)!(...args);
  const enabled = () =>
    context.mock.calls
      .filter(
        ({ arguments: args }) =>
          args[0] === "setContext" && args[1] === "mf-dashboard.canUpdateTypes",
      )
      .at(-1)?.arguments[2];
  assert.equal(enabled(), false);
  await run("rebuildAllTypes");
  assert.equal(progress.mock.callCount(), 0);
  await run("discover");
  assert.equal(enabled(), false);
  writeApp("disabled");
  fs.writeFileSync(
    writeApp("widget"),
    "export default {name:'widget', dts:true, exposes:{'.':'./index.ts'}}",
  );
  const scan = run("discover");
  await run("discover");
  assert.equal(progress.mock.callCount(), 2);
  assert.deepEqual(progress.mock.calls.at(-1)?.arguments[0].location, {
    viewId: "mf-dashboard.discovery",
  });
  await scan;
  assert.equal(enabled(), true);
  await run("rebuildAppTypes", { app: "removed" });
  await run("rebuildAppTypes", { app: "disabled" });
  assert.equal(progress.mock.callCount(), 2);
  const build = run("rebuildAppTypes", { app: "widget" });
  assert.equal(enabled(), false);
  await run("rebuildAllTypes");
  await build;
  assert.equal(progress.mock.callCount(), 3);
  assert.equal(enabled(), true);
  t.mock.method(session, "discover", async () => {
    throw new Error("scan failed");
  });
  await assert.rejects(async () => run("discover"), /scan failed/);
  assert.equal(enabled(), true);
});

test("finding microfrontends hides the previous tree and types view and ignores view commands", async (t) => {
  const { root, writeApp } = fixture(t);
  writeApp("widget");
  const context = t.mock.method(stub.commands, "executeCommand");
  const report = t.mock.method(stub.workspace, "openTextDocument");
  const { session, dashboard, values } = await start(t, root, {
    ...defaultWorkspaceSettings(),
    "mf-dashboard.apps": { widget: { path: "widget" } },
  });
  let complete = () => {};
  const scanning = new Promise<void>((resolve) => {
    complete = resolve;
  });
  t.mock.method(session, "discover", () => scanning);
  const refresh = t.mock.method(session, "refresh");
  const run = (name: string) => stub.registeredCommands.get(`mf-dashboard.${name}`)!();
  const viewVisible = () =>
    context.mock.calls
      .filter(
        ({ arguments: args }) =>
          args[0] === "setContext" && args[1] === "mf-dashboard.typesVisible",
      )
      .at(-1)?.arguments[2];
  assert.equal(viewVisible(), true);
  const scan = run("discover");
  try {
    assert.equal(viewVisible(), false);
    assert.deepEqual(dashboard.getChildren(), []);
    await run("refresh");
    await run("useFlat");
    await run("openTypesBuildReport");
    assert.equal(refresh.mock.callCount(), 0);
    assert.equal(report.mock.callCount(), 0);
    assert.equal(values.get("mf-dashboard.structure"), "tree");
  } finally {
    complete();
    await scan;
  }
  assert.equal(viewVisible(), true);
  assert.equal(dashboard.getChildren()[0]?.name, "widget");
});

for (const duplicate of [false, true]) {
  test(`a saved workspace can run its types build with ${duplicate ? "duplicate names" : "only unreadable configs"}`, async (t) => {
    const { root, writeApp } = fixture(t);
    const configured: Record<string, { path: string }> = { missing: { path: "missing" } };
    if (duplicate) {
      for (const name of ["first", "second", "independent", "disabled"]) {
        const config = writeApp(name);
        if (name === "first" || name === "second")
          fs.writeFileSync(config, "export default {name:'duplicate', dts:false}");
        if (name === "independent")
          fs.writeFileSync(
            config,
            "export default {name:'independent', dts:true, exposes:{'.':'./index.ts'}}",
          );
        configured[name] = { path: name };
      }
    }
    const context = t.mock.method(stub.commands, "executeCommand");
    const document = t.mock.method(stub.workspace, "openTextDocument");
    const { session, values, typesView } = await start(
      t,
      root,
      { ...defaultWorkspaceSettings(), "mf-dashboard.apps": configured },
      undefined,
      false,
      duplicate ? "refresh.failed" : "refresh.completed",
    );
    assert.deepEqual(session.loaded, []);
    const availability = () =>
      context.mock.calls
        .filter(
          ({ arguments: args }) =>
            args[0] === "setContext" && args[1] === "mf-dashboard.canUpdateTypes",
        )
        .map(({ arguments: args }) => args[2]);
    assert.deepEqual(availability(), [false, true]);
    const run = (name: string, ...args: unknown[]) =>
      stub.registeredCommands.get(`mf-dashboard.${name}`)!(...args);
    await run("rebuildAllTypes");
    await run("openTypesBuildReport");
    const report = document.mock.calls.at(-1)?.arguments[0] as unknown as { content: string };
    assert.match(report.content, /missing — Skipped\nCould not read/);
    if (duplicate) {
      assert.match(report.content, /duplicate \(first\) — Skipped/);
      assert.match(report.content, /duplicate \(second\) — Skipped/);
      assert.match(report.content, /disabled — No types to update/);
      const independent = typesView
        .getChildren()
        .find((row) => "app" in row && row.app === "independent");
      assert.ok(independent);
      assert.equal(typesView.getTreeItem(independent).contextValue, "typesBuildApp");
      const conflict = typesView
        .getChildren()
        .filter((row) => "app" in row && row.app === "duplicate");
      assert.equal(conflict.length, 2);
      for (const row of conflict) {
        const item = typesView.getTreeItem(row);
        assert.equal(item.description, "Skipped");
        assert.equal(item.contextValue, undefined);
      }
      const previousUpdates = availability().length;
      await run("rebuildAppTypes", independent);
      assert.deepEqual(availability().slice(previousUpdates), [false, true]);
    }
    values.set("mf-dashboard.apps", {});
    await run("refresh");
    assert.equal(availability().at(-1), false);
  });
}

test("renaming a loaded app to a duplicate keeps both build errors visible", async (t) => {
  const { root, writeApp } = fixture(t);
  writeApp("alpha");
  const beta = writeApp("beta");
  const { session, typesView } = await start(t, root, {
    ...defaultWorkspaceSettings(),
    "mf-dashboard.apps": { alpha: { path: "alpha" }, beta: { path: "beta" } },
  });
  fs.writeFileSync(beta, "export default {name:'alpha', dts:false}");
  const run = (name: string) => stub.registeredCommands.get(`mf-dashboard.${name}`)!();
  await assert.rejects(async () => run("refresh"), /duplicate federation name/);
  assert.deepEqual(
    session.loaded.map(({ name }) => name),
    ["alpha", "beta"],
  );
  await run("rebuildAllTypes");
  const items = typesView.getChildren().map((row) => typesView.getTreeItem(row));
  assert.deepEqual(
    items.map((item) => item.label),
    ["alpha", "alpha (beta)"],
  );
  for (const item of items) {
    assert.equal(item.description, "Skipped");
    assert.match(String(item.tooltip), /Duplicate Module Federation name: alpha/);
  }
});

for (const queueBuild of [false, true]) {
  test(`removing apps clears the build report ${queueBuild ? "with a build queued" : "while refresh is queued"}`, async (t) => {
    const { root, writeApp } = fixture(t);
    writeApp("widget");
    const context = t.mock.method(stub.commands, "executeCommand");
    const { session, values, changes, state, typesView } = await start(t, root, {
      ...defaultWorkspaceSettings(),
      "mf-dashboard.apps": { widget: { path: "widget" } },
    });
    const run = (name: string) => stub.registeredCommands.get(`mf-dashboard.${name}`)!();
    await run("rebuildAllTypes");
    assert.ok(state.get("mf-dashboard.lastTypesBuild"));
    const refresh = session.refresh.bind(session);
    let unblock = () => {};
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    t.mock.method(session, "refresh", async (...args: Parameters<DashboardSession["refresh"]>) => {
      if (args[0] === "manual") await blocked;
      await refresh(...args);
    });
    const pendingRefresh = run("refresh");
    const pendingBuild = queueBuild ? run("rebuildAllTypes") : undefined;
    if (queueBuild) values.set("mf-dashboard.apps", {});
    else values.delete("mf-dashboard.apps");
    changes.fire({
      affectsConfiguration: (key) => key === "mf-dashboard.apps",
    } as ConfigurationChangeEvent);
    const enabled = context.mock.calls
      .filter(
        ({ arguments: args }) =>
          args[0] === "setContext" && args[1] === "mf-dashboard.canUpdateTypes",
      )
      .at(-1)?.arguments[2];
    const pendingAfterClear = run("rebuildAllTypes");
    unblock();
    await Promise.all([pendingRefresh, pendingBuild, pendingAfterClear]);
    await run("refresh");
    assert.equal(enabled, false);
    assert.equal(state.get("mf-dashboard.lastTypesBuild"), undefined);
    assert.deepEqual(typesView.getChildren(), []);
    await run("discover");
    const [widget] = typesView.getChildren();
    assert.equal(typesView.getTreeItem(widget).description, "Not built yet");
  });
}

test("startup diagnostics expose settings writes and preserve all configuration-triggered refreshes", async (t) => {
  const { root, writeApp } = fixture(t);
  writeApp("shell");
  writeApp("widget");
  const { channel, writes } = await start(t, root, {}, undefined, true);
  const refreshes = () => channel.messages.filter((text) => text.startsWith("refresh.started"));
  for (
    const deadline = Date.now() + 5000;
    channel.messages.filter((text) => text.startsWith("refresh.completed")).length < 8 &&
    Date.now() < deadline;
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
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
    fs.writeFileSync(path.join(root, "package.json"), '{"workspaces":["configured"]}');
    fs.writeFileSync(path.join(root, "configured", "package.json"), '{"name":"configured"}');
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
    await session.refresh("manual");
    assert.equal(
      readdir.mock.calls.filter((call) => String(call.arguments[0]).includes("unrelated")).length,
      0,
    );
    await session.discover();
    assert.deepEqual(session.loaded.map((app) => app.name).sort(), [
      "configured",
      "not-yet-discovered",
    ]);
  });
}

test("first startup shares one worker scan and config parse across seeding, discovery and refresh", async (t) => {
  const { root, writeApp } = fixture(t);
  const config = writeApp("discovered");
  const readdir = t.mock.method(fs, "readdirSync");
  const openFile = t.mock.method(fs, "openSync");
  const createOutputChannel = stub.window.createOutputChannel;
  t.mock.method(
    stub.window,
    "createOutputChannel",
    (...args: Parameters<typeof createOutputChannel>) => {
      const channel = createOutputChannel(...args);
      channel.logLevel = stub.LogLevel.Trace;
      return channel;
    },
  );
  const { session, values, channel } = await start(t, root, {});
  assert.deepEqual(
    session.loaded.map((app) => app.name),
    ["discovered"],
  );
  assert.equal(readdir.mock.calls.filter((call) => String(call.arguments[0]) === root).length, 0);
  assert.equal(
    openFile.mock.calls.filter((call) => String(call.arguments[0]) === config).length,
    0,
  );
  assert.equal(
    channel.messages.filter((line) => line.startsWith("discovery.scan.started")).length,
    1,
  );
  assert.equal(
    channel.messages.filter(
      (line) =>
        line.startsWith("discovery.candidate") && line.includes("module-federation.config.ts"),
    ).length,
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
    const { session, writes, channel } = await start(
      t,
      root,
      apps === undefined ? {} : { "mf-dashboard.apps": apps },
    );
    assert.deepEqual(session.loaded, []);
    assert.deepEqual(writes, []);
    assert.equal(readdir.mock.calls.filter((call) => String(call.arguments[0]) === root).length, 0);
    assert.equal(
      channel.messages.filter((line) => line.startsWith("discovery.scan.started")).length,
      apps === undefined ? 1 : 0,
    );
  });
}

test("worker discovery does not overwrite app settings changed while scanning", async (t) => {
  const { root, writeApp } = fixture(t);
  writeApp("discovered");
  const worker = new KnownAppsWorker();
  t.after(() => worker.dispose());
  let settings: DashboardSettings = {
    apps: undefined,
    envMode: "development",
    ignorePaths: [],
    extraManifestUrls: [],
    structure: "tree",
  };
  const replacement = { manual: { path: "manual" } };
  const session = new DashboardSession(
    {
      readSettings: () => settings,
      writeApps: () => assert.fail("stale discovery must not write app settings"),
      scan: prepareWorkspaceScan,
      loadKnown: loadKnownApps,
      planDiscovery: async (roots, current, previous, log) => {
        const pending = worker.request("discover", { roots, settings: current, previous }, log);
        settings = { ...settings, apps: replacement };
        return pending;
      },
      roots: () => [{ name: "workspace", path: root }],
      async probe() {},
    },
    createProbeBook(),
  );
  await assert.rejects(session.discover(), /Workspace settings changed during Discover/);
  assert.equal(settings.apps, replacement);
});

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

test("Discover parses each configured Rslib alias once per operation", async (t) => {
  const { root } = fixture(t);
  const apps = Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => {
      const project = `project-${i}`;
      const folder = path.join(root, project);
      fs.mkdirSync(folder);
      fs.writeFileSync(path.join(folder, "package.json"), '{"scripts":{"serve":"rslib mf-dev"}}');
      fs.writeFileSync(
        path.join(folder, "rslib.config.ts"),
        `export default { lib: [{ format: 'mf', plugins: [pluginModuleFederation({ name: '${project}' })] }] };`,
      );
      return [`alias-${i}`, { path: project, scripts: { start: "serve" } }];
    }),
  );
  const current: DashboardSettings = {
    apps,
    envMode: "development",
    ignorePaths: [],
    extraManifestUrls: [],
    structure: "tree",
  };
  const readdir = t.mock.method(fs, "readdirSync");
  let firstRead = 0;
  let lookupFolders: string[] = [];
  const session = new DashboardSession(
    {
      roots: () => [{ name: "workspace", path: root }],
      readSettings: () => current,
      writeApps(next) {
        current.apps = next;
      },
      scan: prepareWorkspaceScan,
      loadKnown(...args) {
        lookupFolders = readdir.mock.calls
          .slice(firstRead)
          .flatMap(({ arguments: [folder, opts] }) =>
            typeof folder === "string" && typeof opts === "object" && opts?.withFileTypes
              ? [folder]
              : [],
          );
        return loadKnownApps(...args);
      },
      async probe() {},
    },
    createProbeBook(),
  );
  const folders = Object.values(apps)
    .map(({ path: rel }) => path.join(root, rel))
    .sort();
  for (let operation = 0; operation < 2; operation++) {
    session.prepareDiscovery();
    firstRead = readdir.mock.callCount();
    await session.discover();
    assert.deepEqual(lookupFolders.sort(), folders);
    assert.strictEqual(current.apps, apps);
    assert.deepEqual(
      session.loaded.map(({ settingsKey }) => settingsKey),
      Object.keys(apps),
    );
  }
});

test("Discover resolves Rslib alias paths once per lookup cache", (t) => {
  const { root, writeApp } = fixture(t);
  const folder = path.dirname(writeApp("library"));
  const canonical = fs.realpathSync.native(folder);
  const realpath = t.mock.method(fs.realpathSync, "native");
  for (let operation = 0; operation < 2; operation++) {
    realpath.mock.resetCalls();
    const lookups = createDiscoveryLookups("development");
    assert.equal(lookups.confinedAppPath(root, "library")?.canonical, canonical);
    assert.equal(lookups.confinedAppPath(root, folder)?.canonical, canonical);
    assert.equal(lookups.sameFile(folder, canonical), true);
    assert.deepEqual(
      realpath.mock.calls.map(({ arguments: [file] }) => file),
      [folder, root],
    );
  }
});

test("Discover preserves saved Rslib entries when an unrelated launcher targets their project", async (t) => {
  const { root } = fixture(t);
  const project = path.join(root, "library");
  const launcher = path.join(root, "sibling-launcher");
  fs.mkdirSync(project);
  fs.mkdirSync(launcher);
  fs.writeFileSync(path.join(project, "package.json"), "{}");
  fs.writeFileSync(
    path.join(project, "rslib.config.ts"),
    `
    export default {
      lib: [{ format: 'mf', plugins: [pluginModuleFederation({ name: 'library' })] }],
    };
  `,
  );
  const saved = { path: "library", manifestPath: "/custom.json" };
  const { session, values, writes } = await start(t, root, {
    "mf-dashboard.apps": { library: saved },
  });
  fs.writeFileSync(
    path.join(launcher, "package.json"),
    '{"scripts":{"dev":"rslib mf-dev --root ../library"}}',
  );
  for (const key of ["library", "legacy"]) {
    const apps = { [key]: saved };
    values.set("mf-dashboard.apps", apps);
    const count = writes.length;
    await session.discover();
    assert.equal(values.get("mf-dashboard.apps"), apps);
    assert.equal(writes.length, count);
    assert.deepEqual(
      session.loaded.map(({ settingsKey, folder, launchFolder }) => [
        settingsKey,
        folder,
        launchFolder,
      ]),
      [[key, project, undefined]],
    );
  }
});

test("First Discover keeps the direct Rslib project when a sibling targets its config", async (t) => {
  const { root } = fixture(t);
  const launcher = path.join(root, "a-launcher");
  const project = path.join(root, "project");
  fs.mkdirSync(launcher);
  fs.mkdirSync(project);
  fs.symlinkSync(project, path.join(launcher, "project-link"), "dir");
  fs.writeFileSync(path.join(project, "package.json"), "{}");
  fs.writeFileSync(
    path.join(project, "rslib.config.ts"),
    `export default { lib: [{ format: 'mf', plugins: [pluginModuleFederation({ name: 'library' })] }] };`,
  );
  const workspaceRoot = { name: "workspace", path: root };
  const projectRoot = { name: "project", path: project };
  let roots = [workspaceRoot];
  const current: DashboardSettings = {
    apps: undefined,
    envMode: "development",
    ignorePaths: [],
    extraManifestUrls: [],
    structure: "tree",
  };
  const worker = new KnownAppsWorker();
  t.after(() => worker.dispose());
  const session = new DashboardSession(
    {
      readSettings: () => current,
      writeApps(apps) {
        current.apps = apps;
      },
      scan: prepareWorkspaceScan,
      loadKnown: loadKnownApps,
      loadKnownAsync: (roots, settings, log, discovery) =>
        worker.load({ roots, settings, discovery }, log),
      roots: () => roots,
      async probe() {},
    },
    createProbeBook(),
  );
  const loaded = () =>
    session.loaded.map(({ name, folder, launchFolder }) => [name, folder, launchFolder]);
  for (const target of ["../project", "project-link"]) {
    fs.writeFileSync(
      path.join(launcher, "package.json"),
      JSON.stringify({ scripts: { dev: `rslib mf-dev --root ${target}` } }),
    );
    for (const layout of [
      [workspaceRoot],
      [workspaceRoot, projectRoot],
      [projectRoot, workspaceRoot],
    ]) {
      roots = layout;
      current.apps = undefined;
      await session.discover();
      assert.deepEqual(current.apps, {
        library: {
          path: path.relative(roots[0].path, project) || ".",
          ...(roots.length > 1 && { workspaceFolder: roots[0].name }),
        },
      });
      assert.deepEqual(loaded(), [["library", project, undefined]]);
    }
  }

  for (const key of ["library", "legacy"]) {
    const configured = { [key]: { path: "a-launcher", workspaceFolder: "workspace" } };
    current.apps = configured;
    await session.discover();
    assert.equal(current.apps, configured);
    assert.deepEqual(loaded(), [["library", project, launcher]]);
  }
});

test("Discover repairs a saved Rslib project path using its launcher", async (t) => {
  const { root } = fixture(t);
  const launcher = path.join(root, "z-launch");
  const project = path.join(launcher, "project");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(
    path.join(launcher, "package.json"),
    '{"scripts":{"dev":"PORT=4600 rslib mf-dev --root project"}}',
  );
  fs.writeFileSync(
    path.join(project, "rslib.config.ts"),
    `export default {
    server: { port: process.env.PORT },
    lib: [{ format: 'mf', plugins: [pluginModuleFederation({ name: 'nested' })] }],
  };`,
  );
  const saved = {
    path: "z-launch/project",
    manifestPath: "/custom.json",
    typesZipPath: "dist/custom.zip",
  };
  const { session, values, writes } = await start(t, root, {
    "mf-dashboard.apps": { nested: saved },
  });
  assert.equal(session.loaded[0]?.launchFolder, undefined);
  await session.discover();
  assert.deepEqual(values.get("mf-dashboard.apps"), { nested: { ...saved, path: "z-launch" } });
  assert.equal(session.loaded[0]?.folder, project);
  assert.equal(session.loaded[0]?.launchFolder, launcher);
  assert.equal(session.loaded[0]?.manifestPath, "/custom.json");
  assert.equal(session.loaded[0]?.port, 4600);
  const commands: string[] = [];
  const createTerminal = t.mock.fn((_options: { cwd: string }) => ({
    sendText: (command: string) => commands.push(command),
    show() {},
  }));
  Object.assign(stub.window, { createTerminal });
  t.after(() => Reflect.deleteProperty(stub.window, "createTerminal"));
  const { startRow } = await import("../src/widgets/mf-dashboard-tree/lib/start-row.ts");
  await startRow(session.loaded[0], session, noLog);
  assert.equal(createTerminal.mock.calls[0]?.arguments[0]?.cwd, launcher);
  assert.deepEqual(commands, ["npm run dev"]);
  const writesAfterMigration = writes.length;
  await session.discover();
  assert.equal(writes.length, writesAfterMigration);
  values.set("mf-dashboard.apps", { legacy: saved, nested: { path: "z-launch" } });
  await session.refresh();
  assert.deepEqual(
    session.loaded.map(({ settingsKey, launchFolder }) => [settingsKey, launchFolder]),
    [["nested", launcher]],
  );
  values.set("mf-dashboard.apps", { oldName: saved });
  await session.discover();
  assert.deepEqual(values.get("mf-dashboard.apps"), { nested: { ...saved, path: "z-launch" } });
  assert.equal(session.loaded[0]?.manifestPath, "/custom.json");

  for (const pinned of [
    { ...saved, configFile: "rslib.config.ts" },
    { ...saved, scripts: { start: "custom" } },
  ]) {
    values.set("mf-dashboard.apps", { nested: pinned });
    await session.discover();
    assert.deepEqual(values.get("mf-dashboard.apps"), { nested: pinned });
  }
  const pinnedAlias = { oldName: { ...saved, configFile: "rslib.config.ts" } };
  values.set("mf-dashboard.apps", pinnedAlias);
  const writesBeforePinnedAlias = writes.length;
  await session.discover();
  assert.deepEqual(values.get("mf-dashboard.apps"), pinnedAlias);
  assert.equal(writes.length, writesBeforePinnedAlias);
  await session.refresh();
  assert.deepEqual(
    session.loaded.map(({ name, settingsKey, manifestPath }) => [name, settingsKey, manifestPath]),
    [["nested", "oldName", "/custom.json"]],
  );
  fs.writeFileSync(path.join(project, "package.json"), '{"scripts":{"dev":"node serve.mjs"}}');
  values.set("mf-dashboard.apps", { nested: saved });
  await session.discover();
  assert.deepEqual(values.get("mf-dashboard.apps"), { nested: saved });
  const defaultStartAlias = { oldName: saved };
  values.set("mf-dashboard.apps", defaultStartAlias);
  const writesBeforeDefaultStartAlias = writes.length;
  await session.discover();
  assert.deepEqual(values.get("mf-dashboard.apps"), defaultStartAlias);
  assert.equal(writes.length, writesBeforeDefaultStartAlias);
  assert.deepEqual(
    session.loaded.map(({ settingsKey, folder, launchFolder, manifestPath }) => [
      settingsKey,
      folder,
      launchFolder,
      manifestPath,
    ]),
    [["oldName", project, undefined, "/custom.json"]],
  );
  fs.writeFileSync(
    path.join(project, "package.json"),
    '{"scripts":{"serve":"PORT=4602 rslib mf-dev"}}',
  );
  const customStartAlias = { oldName: { ...saved, scripts: { start: "serve" } } };
  values.set("mf-dashboard.apps", customStartAlias);
  await session.discover();
  assert.deepEqual(values.get("mf-dashboard.apps"), customStartAlias);
  await session.refresh();
  assert.deepEqual(
    session.loaded.map(({ settingsKey, port }) => [settingsKey, port]),
    [["oldName", 4602]],
  );

  fs.mkdirSync(path.join(project, "config"));
  fs.writeFileSync(
    path.join(project, "config", "custom.ts"),
    `import { defineConfig } from '@rslib/core';
    export default defineConfig({
      server: { port: 4603 },
      lib: [{ format: 'mf', plugins: [pluginModuleFederation({ name: 'nested' })] }],
    });`,
  );
  const writesBeforeCurrentAliases = writes.length;
  for (const [entry, expectedPort] of [
    [{ ...saved, configFile: "config/custom.ts" }, 4603],
    [{ ...saved, path: "z-launch" }, 4600],
  ] as const) {
    const apps = { oldName: entry };
    values.set("mf-dashboard.apps", apps);
    await session.discover();
    assert.deepEqual(values.get("mf-dashboard.apps"), apps);
    assert.equal(writes.length, writesBeforeCurrentAliases);
    assert.deepEqual(
      session.loaded.map(({ settingsKey, port, manifestPath }) => [
        settingsKey,
        port,
        manifestPath,
      ]),
      [["oldName", expectedPort, "/custom.json"]],
    );
  }

  values.set("mf-dashboard.apps", { broken: null });
  await session.discover();
  assert.deepEqual(values.get("mf-dashboard.apps"), { broken: null, nested: { path: "z-launch" } });
  assert.deepEqual(
    session.loaded.map(({ settingsKey }) => settingsKey),
    ["nested"],
  );

  const ambiguousAliases = { first: { path: "z-launch" }, second: { path: "z-launch" } };
  values.set("mf-dashboard.apps", ambiguousAliases);
  await session.discover();
  assert.deepEqual(values.get("mf-dashboard.apps"), {
    ...ambiguousAliases,
    nested: { path: "z-launch" },
  });
  assert.deepEqual(
    session.loaded.map(({ settingsKey }) => settingsKey),
    ["nested"],
  );
});

test("Discover moves a saved standalone helper to its Rslib owner and preserves settings", async (t) => {
  const { root } = fixture(t);
  const helperFolder = path.join(root, "library", "shared");
  fs.mkdirSync(helperFolder, { recursive: true });
  fs.writeFileSync(path.join(root, "library", "package.json"), "{}");
  fs.writeFileSync(
    path.join(helperFolder, "module-federation.config.ts"),
    `export default { name: 'designKit' };`,
  );
  fs.writeFileSync(
    path.join(root, "library", "rslib.config.ts"),
    `
    import mf from './shared/module-federation.config';
    export default { lib: [{ format: 'mf', plugins: [pluginModuleFederation(mf)] }] };
  `,
  );
  const settings = {
    path: "library/shared",
    manifestPath: "/custom.json",
    typesZipPath: "../dist/custom.zip",
  };
  const migrated = { ...settings, path: "library", typesZipPath: "dist/custom.zip" };
  const current: DashboardSettings = {
    apps: { designKit: settings },
    envMode: "development",
    ignorePaths: [],
    extraManifestUrls: [],
    structure: "tree",
  };
  let writes = 0;
  const session = new DashboardSession(
    {
      readSettings: () => current,
      writeApps(apps) {
        writes++;
        current.apps = apps;
      },
      scan: scanWorkspace,
      loadKnown: loadKnownApps,
      roots: () => [{ name: "workspace", path: root }],
      async probe() {},
    },
    createProbeBook(),
  );
  await session.refresh();
  assert.equal(session.loaded.length, 0);
  await session.discover();
  assert.deepEqual(current.apps, { designKit: migrated });
  assert.equal(session.loaded[0]?.folder, path.join(root, "library"));
  assert.equal(session.loaded[0]?.manifestPath, "/custom.json");
  await session.discover();
  assert.equal(writes, 1);
  const explicit = { ...settings, configFile: "module-federation.config.ts" };
  current.apps = { designKit: explicit };
  await session.discover();
  assert.deepEqual(current.apps, { designKit: explicit });
  assert.equal(writes, 1);
  current.apps = { oldName: explicit };
  await session.discover();
  assert.deepEqual(current.apps, { oldName: explicit });
  assert.deepEqual(
    session.loaded.map(({ name, settingsKey, manifestPath }) => [name, settingsKey, manifestPath]),
    [["designKit", "oldName", "/custom.json"]],
  );
  assert.equal(writes, 1);
  current.apps = { oldName: settings };
  await session.discover();
  assert.deepEqual(current.apps, { designKit: migrated });

  fs.writeFileSync(
    path.join(helperFolder, "rspack.config.ts"),
    `
    export default { plugins: [new ModuleFederationPlugin({ name: 'unrelated' })] };
  `,
  );
  const unrelated = { path: "library/shared" };
  current.apps = { designKit: { ...settings, typesZipPath: "../ custom.zip /." }, unrelated };
  await session.discover();
  assert.deepEqual(current.apps, {
    designKit: { ...migrated, typesZipPath: "./ custom.zip /." },
    unrelated,
  });
  assert.deepEqual(
    session.loaded.map(({ name }) => name),
    ["designKit", "unrelated"],
  );

  const configured = {
    ...unrelated,
    manifestPath: "/unrelated.json",
    typesZipPath: "my-types.zip",
  };
  current.apps = { unrelated: configured };
  await session.refresh();
  assert.deepEqual(
    session.loaded.map(({ name, manifestPath }) => [name, manifestPath]),
    [["unrelated", "/unrelated.json"]],
  );
  await session.discover();
  assert.deepEqual(current.apps, { unrelated: configured, designKit: { path: "library" } });
  assert.deepEqual(
    session.loaded.map(({ name, manifestPath }) => [name, manifestPath]),
    [
      ["unrelated", "/unrelated.json"],
      ["designKit", "/mf-manifest.json"],
    ],
  );
});

test("Refresh tracks helper ownership through a sibling Rslib launcher's custom config", async (t) => {
  const { root } = fixture(t);
  for (const directory of ["helper", "launcher", "project"])
    fs.mkdirSync(path.join(root, directory));
  fs.writeFileSync(
    path.join(root, "helper", "module-federation.config.ts"),
    `export default { name: 'designKit' };`,
  );
  fs.writeFileSync(
    path.join(root, "custom.ts"),
    `import mf from './helper/module-federation.config';
    export default { lib: [{ format: 'mf', plugins: [pluginModuleFederation(mf)] }] };`,
  );
  const launcherPackage = path.join(root, "launcher", "package.json");
  fs.writeFileSync(launcherPackage, "{}");
  const { session } = await start(t, root, {
    "mf-dashboard.apps": { legacy: { path: "helper" }, designKit: { path: "launcher" } },
  });
  assert.equal(session.loaded[0]?.settingsKey, "legacy");

  fs.writeFileSync(
    launcherPackage,
    '{"scripts":{"dev":"rslib mf-dev --root ../project --config ../custom.ts"}}',
  );
  await session.refresh("timer");
  assert.deepEqual(
    session.loaded.map(({ settingsKey, folder }) => [settingsKey, folder]),
    [["designKit", path.join(root, "project")]],
  );

  fs.writeFileSync(launcherPackage, "{}");
  await session.refresh("manual");
  assert.deepEqual(
    session.loaded.map(({ settingsKey }) => settingsKey),
    ["legacy"],
  );
});

test("timer refresh keeps ownership scans off the host on cache hits and misses", async (t) => {
  const { root, writeApp } = fixture(t);
  writeApp("web");
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  const library = path.join(root, "unrelated", "nested");
  const worker = new KnownAppsWorker();
  t.after(() => worker.dispose());
  const current: DashboardSettings = {
    apps: { web: { path: "web" } },
    envMode: "development",
    ignorePaths: [],
    extraManifestUrls: [],
    structure: "tree",
  };
  const session = new DashboardSession(
    {
      readSettings: () => current,
      writeApps: () => assert.fail("refresh must not write settings"),
      scan: scanWorkspace,
      loadKnown: loadKnownApps,
      loadKnownAsync: (roots, settings, log) => worker.load({ roots, settings }, log),
      roots: () => [{ name: "workspace", path: root }],
      async probe() {},
    },
    createProbeBook(),
  );
  await session.refresh();
  const stat = t.mock.method(fs, "statSync");
  const readdir = t.mock.method(fs, "readdirSync");
  await session.refresh("timer");
  await session.refresh("timer");
  fs.writeFileSync(path.join(library, "unrelated.txt"), "ordinary build artifact");
  await session.refresh("timer");
  assert.deepEqual(
    session.loaded.map(({ name }) => name),
    ["web"],
  );
  const config = path.join(library, "rslib.config.ts");
  fs.writeFileSync(path.join(library, ".env"), "NODE_ENV=production\n");
  fs.writeFileSync(config, developmentFederationConfig("../../web/module-federation.config"));
  await session.refresh("timer");
  assert.equal(session.loaded.length, 0);
  fs.unlinkSync(config);
  await session.refresh("timer");
  assert.deepEqual(
    session.loaded.map(({ name }) => name),
    ["web"],
  );
  for (const calls of [stat.mock.calls, readdir.mock.calls]) {
    assert.equal(
      calls.filter(({ arguments: [file] }) => String(file).startsWith(path.dirname(library)))
        .length,
      0,
    );
  }
});

test("known app worker delivers diagnostics at the requested log level", async (t) => {
  const { root, writeApp } = fixture(t);
  writeApp("web");
  const worker = new KnownAppsWorker();
  t.after(() => worker.dispose());
  const settings: DashboardSettings = {
    apps: { web: { path: "web" } },
    envMode: "development",
    ignorePaths: [],
    extraManifestUrls: [],
    structure: "tree",
  };
  const task = { roots: [{ name: "root", path: root }], settings };
  const messages: string[] = [];
  let verbose = false;
  const log = createLogger({
    enabled: () => verbose,
    write: (_level, message) => messages.push(message),
  });
  await worker.load(task, log);
  assert.equal(messages.length, 0);
  verbose = true;
  await worker.load(task, log);
  assert.ok(messages.some((message) => message.startsWith("config.cache.hit")));
  messages.length = 0;
  fs.writeFileSync(
    path.join(root, "web", "module-federation.config.ts"),
    `export default { name: 'renamed' };`,
  );
  await worker.load(task, log);
  assert.ok(messages.some((message) => message.startsWith("config.cache.miss")));
  assert.ok(messages.some((message) => message.startsWith("discovery.candidate")));
});

test("Discover loads each app once across overlapping workspace folders", async (t) => {
  const { root, writeApp } = fixture(t);
  const web = path.dirname(writeApp("web"));
  const library = path.join(root, "packages", "library");
  fs.mkdirSync(library, { recursive: true });
  fs.writeFileSync(
    path.join(library, "rslib.config.ts"),
    `export default { lib: [{ format: 'mf', plugins: [pluginModuleFederation({ name: 'library' })] }] };`,
  );
  const linkedLibrary = path.join(root, "linked-library");
  fs.symlinkSync(library, linkedLibrary, "dir");
  const roots = [
    { name: "workspace", path: root },
    { name: "library", path: library },
    { name: "linked-library", path: linkedLibrary },
    { name: "web", path: web },
  ];
  const current: DashboardSettings = {
    apps: undefined,
    envMode: "development",
    ignorePaths: [],
    extraManifestUrls: [],
    structure: "tree",
  };
  const worker = new KnownAppsWorker();
  t.after(() => worker.dispose());
  let writes = 0;
  const session = new DashboardSession(
    {
      readSettings: () => current,
      writeApps(apps) {
        writes++;
        current.apps = apps;
      },
      scan: prepareWorkspaceScan,
      loadKnown: loadKnownApps,
      loadKnownAsync: (roots, settings, log, discovery) =>
        worker.load({ roots, settings, discovery }, log),
      roots: () => roots,
      async probe() {},
    },
    createProbeBook(),
  );
  assert.deepEqual(session.prepareDiscovery(), ["library", "web"]);
  await session.discover();
  assert.deepEqual(current.apps, {
    library: { path: "packages/library", workspaceFolder: "workspace" },
    web: { path: "web", workspaceFolder: "workspace" },
  });
  const loaded = () => session.loaded.map(({ name, folder }) => [name, folder]);
  assert.deepEqual(loaded(), [
    ["library", library],
    ["web", web],
  ]);
  await session.refresh();
  assert.deepEqual(loaded(), [
    ["library", library],
    ["web", web],
  ]);
  await session.discover();
  assert.equal(writes, 1);
});

test("Discover keeps the Rslib --root launcher when its project is also a workspace root", async (t) => {
  const { root } = fixture(t);
  const launcher = path.join(root, "z-launch");
  const project = path.join(launcher, "project");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(
    path.join(launcher, "package.json"),
    '{"scripts":{"dev":"PORT=4600 rslib mf-dev --root project"}}',
  );
  fs.writeFileSync(
    path.join(project, "rslib.config.ts"),
    `export default {
      server: { port: process.env.PORT },
      lib: [{ format: 'mf', plugins: [pluginModuleFederation({ name: 'library' })] }],
    };`,
  );
  const workspaceRoot = { name: "workspace", path: root };
  const projectRoot = { name: "project", path: project };
  const worker = new KnownAppsWorker();
  t.after(() => worker.dispose());
  const current: DashboardSettings = {
    apps: undefined,
    envMode: "development",
    ignorePaths: [],
    extraManifestUrls: [],
    structure: "tree",
  };
  let roots = [workspaceRoot, projectRoot];
  const session = new DashboardSession(
    {
      readSettings: () => current,
      writeApps(apps) {
        current.apps = apps;
      },
      scan: prepareWorkspaceScan,
      loadKnown: loadKnownApps,
      loadKnownAsync: (roots, settings, log, discovery) =>
        worker.load({ roots, settings, discovery }, log),
      roots: () => roots,
      async probe() {},
    },
    createProbeBook(),
  );
  const expectedSettings = { library: { path: "z-launch", workspaceFolder: "workspace" } };
  const loaded = () =>
    session.loaded.map(({ name, folder, launchFolder, port }) => [
      name,
      folder,
      launchFolder,
      port,
    ]);

  await session.discover();
  assert.deepEqual(current.apps, expectedSettings);
  assert.deepEqual(loaded(), [["library", project, launcher, 4600]]);

  roots = [projectRoot, workspaceRoot];
  const overrides = { manifestPath: "/custom.json", typesZipPath: "dist/custom.zip" };
  current.apps = { library: { path: ".", workspaceFolder: "project", ...overrides } };
  await session.discover();
  assert.deepEqual(current.apps, { library: { ...expectedSettings.library, ...overrides } });
  await session.refresh();
  assert.deepEqual(loaded(), [["library", project, launcher, 4600]]);
  assert.equal(session.loaded[0]?.manifestPath, overrides.manifestPath);

  const linkedProject = path.join(root, "linked-project");
  fs.symlinkSync(project, linkedProject, "dir");
  const linkedRoot = { name: "linked-project", path: linkedProject };
  const originalZip = path.join(project, overrides.typesZipPath);
  fs.mkdirSync(path.dirname(originalZip));
  fs.writeFileSync(originalZip, "existing types archive");
  for (const projectRoots of [
    [projectRoot, linkedRoot],
    [linkedRoot, projectRoot],
  ]) {
    roots = [...projectRoots, workspaceRoot];
    current.apps = { library: { path: ".", ...overrides } };
    await session.discover();
    const migrated = current.apps.library;
    assert.equal(migrated.path, expectedSettings.library.path);
    assert.equal(migrated.workspaceFolder, expectedSettings.library.workspaceFolder);
    assert.equal(migrated.manifestPath, overrides.manifestPath);
    assert.ok(migrated.typesZipPath);
    assert.equal(
      fs.realpathSync(path.resolve(project, migrated.typesZipPath)),
      fs.realpathSync(originalZip),
    );
    await session.refresh();
    assert.deepEqual(loaded(), [["library", project, launcher, 4600]]);
    assert.equal(session.loaded[0]?.manifestPath, overrides.manifestPath);
  }

  fs.writeFileSync(
    path.join(project, "package.json"),
    '{"scripts":{"dev":"PORT=4601 rslib mf-dev"}}',
  );
  const before = current.apps;
  await assert.rejects(session.discover(), /duplicate federation name: library/);
  assert.equal(current.apps, before);
  assert.deepEqual(loaded(), [["library", project, launcher, 4600]]);
});

test("Discover and configured loading share federation helper ownership across workspace folders", async (t) => {
  const { root } = fixture(t);
  const shared = path.join(root, "shared");
  const owner = path.join(root, "owner");
  fs.mkdirSync(shared);
  fs.mkdirSync(owner);
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  const helper = "module-federation.config.ts";
  fs.writeFileSync(path.join(shared, helper), `export default { name: 'library' };`);
  fs.writeFileSync(
    path.join(owner, "rslib.config.ts"),
    `
    import mf from '../shared/module-federation.config';
    export default { lib: [{ format: 'mf', plugins: [pluginModuleFederation(mf)] }] };
  `,
  );
  const roots = [
    { name: "shared", path: shared },
    { name: "owner", path: owner },
  ];
  const saved = { path: ".", workspaceFolder: "shared", typesZipPath: "dist/types.zip" };
  const worker = new KnownAppsWorker();
  t.after(() => worker.dispose());
  const current: DashboardSettings = {
    apps: { library: saved },
    envMode: "development",
    ignorePaths: [],
    extraManifestUrls: [],
    structure: "tree",
  };
  assert.deepEqual(loadKnownApps(roots, current.apps!, "development"), []);
  const pinned = { ...saved, configFile: helper };
  assert.equal(loadKnownApps(roots, { library: pinned }, "development")[0]?.folder, shared);
  const session = new DashboardSession(
    {
      readSettings: () => current,
      writeApps(apps) {
        current.apps = apps;
      },
      scan: prepareWorkspaceScan,
      loadKnown: loadKnownApps,
      loadKnownAsync: (roots, settings, log, discovery) =>
        worker.load({ roots, settings, discovery }, log),
      roots: () => roots,
      async probe() {},
    },
    createProbeBook(),
  );
  await session.discover();
  assert.deepEqual(current.apps, {
    library: { path: ".", workspaceFolder: "owner", typesZipPath: "../shared/dist/types.zip" },
  });
  assert.deepEqual(
    session.loaded.map((app) => app.folder),
    [owner],
  );
  await session.refresh();
  assert.deepEqual(
    session.loaded.map((app) => app.folder),
    [owner],
  );
});

test("configured loading suppresses a helper in a nested workspace root without package.json", (t) => {
  const { root } = fixture(t);
  const shared = path.join(root, "shared");
  fs.mkdirSync(shared);
  fs.writeFileSync(
    path.join(shared, "module-federation.config.ts"),
    `export default { name: 'library' };`,
  );
  fs.writeFileSync(
    path.join(root, "rslib.config.ts"),
    `
    import mf from './shared/module-federation.config';
    export default { lib: [{ format: 'mf', plugins: [pluginModuleFederation(mf)] }] };
  `,
  );
  const roots = [
    { name: "shared", path: shared },
    { name: "owner", path: root },
  ];
  const apps = loadKnownApps(
    roots,
    {
      legacy: { path: ".", workspaceFolder: "shared" },
      library: { path: ".", workspaceFolder: "owner" },
    },
    "development",
  );
  assert.deepEqual(
    apps.map(({ name, folder }) => [name, folder]),
    [["library", root]],
  );
});

test("an unqualified start override skips owned helpers in earlier workspace folders", async (t) => {
  const { root } = fixture(t);
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  fs.mkdirSync(path.join(first, "app"), { recursive: true });
  fs.mkdirSync(path.join(first, "owner"));
  fs.mkdirSync(path.join(second, "app", "shared"), { recursive: true });
  const helper = `export default { name: 'client' };`;
  fs.writeFileSync(path.join(first, "package.json"), "{}");
  fs.writeFileSync(path.join(first, "app", "module-federation.config.ts"), helper);
  fs.writeFileSync(path.join(first, "owner", ".env"), "NODE_ENV=production\n");
  fs.writeFileSync(
    path.join(first, "owner", "rslib.config.ts"),
    developmentFederationConfig("../app/module-federation.config"),
  );
  const owner = path.join(second, "app");
  fs.writeFileSync(
    path.join(owner, "package.json"),
    '{"scripts":{"serve":"rslib mf-dev -c custom.ts"}}',
  );
  fs.writeFileSync(path.join(owner, "shared", "module-federation.config.ts"), helper);
  fs.writeFileSync(
    path.join(owner, "custom.ts"),
    `import mf from './shared/module-federation.config';
    export default { lib: [{ format: 'mf', plugins: [pluginModuleFederation(mf)] }] };`,
  );
  const roots = [
    { name: "first", path: first },
    { name: "second", path: second },
  ];
  const worker = new KnownAppsWorker();
  t.after(() => worker.dispose());
  const settings: DashboardSettings = {
    apps: {
      client: { path: "app", scripts: { start: "serve" } },
      legacy: { path: "app/shared", workspaceFolder: "second" },
    },
    envMode: "development",
    ignorePaths: [],
    extraManifestUrls: [],
    structure: "tree",
  };
  const load = () => worker.load({ roots, settings }, noLog);
  const { apps } = await load();
  assert.deepEqual(
    apps.map(({ folder }) => folder),
    [owner],
  );
  fs.unlinkSync(path.join(first, "owner", "rslib.config.ts"));
  const changed = await load();
  assert.deepEqual(
    changed.apps.map(({ folder }) => folder),
    [path.join(first, "app"), path.join(owner, "shared")],
  );
  const firstOwner = path.join(first, "owner");
  fs.writeFileSync(
    path.join(firstOwner, "package.json"),
    '{"scripts":{"serve":"rslib mf-dev -c custom.ts"}}',
  );
  fs.writeFileSync(
    path.join(firstOwner, "custom.ts"),
    `import mf from './module-federation.config';
    export default { lib: [{ format: 'mf', plugins: [pluginModuleFederation(mf)] }] };`,
  );
  fs.writeFileSync(
    path.join(firstOwner, "module-federation.config.ts"),
    `export default { name: 'server' };`,
  );
  fs.renameSync(path.join(first, "app"), path.join(firstOwner, "app"));
  fs.writeFileSync(
    path.join(firstOwner, "rslib.config.ts"),
    developmentFederationConfig("./app/module-federation.config"),
  );
  const inactive = path.join(firstOwner, "app", "inactive");
  fs.mkdirSync(inactive);
  fs.writeFileSync(path.join(inactive, "module-federation.config.ts"), helper);
  fs.writeFileSync(path.join(firstOwner, "app", ".env"), "NODE_ENV=production\n");
  fs.writeFileSync(
    path.join(firstOwner, "app", "rslib.config.ts"),
    developmentFederationConfig("./inactive/module-federation.config"),
  );
  fs.mkdirSync(path.join(second, "owner"));
  fs.renameSync(owner, path.join(second, "owner", "app"));
  const client = { path: "owner/app", scripts: { start: "serve" } };
  const legacy = { path: "owner/app/shared", workspaceFolder: "second" };
  fs.writeFileSync(
    path.join(firstOwner, "vite.config.ts"),
    `export default { plugins: [pluginModuleFederation({ name: 'server' })] };`,
  );
  for (const configFile of [undefined, "vite.config.ts"]) {
    const server = { path: "owner", scripts: { start: "serve" }, configFile };
    for (const apps of [
      { client, server, legacy },
      { server, client, legacy },
    ]) {
      settings.apps = apps;
      assert.deepEqual((await load()).apps.map(({ name }) => name).sort(), ["client", "server"]);
    }
  }
  settings.ignorePaths = ["owner"];
  fs.writeFileSync(path.join(firstOwner, "package.json"), '{"scripts":{"serve":"vite"}}');
  fs.writeFileSync(path.join(firstOwner, ".env"), "NODE_ENV=production\n");
  fs.writeFileSync(
    path.join(firstOwner, "module-federation.config.ts"),
    `export default { name: 'server', dts: false };`,
  );
  fs.writeFileSync(
    path.join(firstOwner, "vite.config.ts"),
    `import mf from './module-federation.config';
    export default { plugins: [pluginModuleFederation(mf)] };`,
  );
  const server = { path: "owner", scripts: { start: "serve" } };
  for (const apps of [
    { client, server, legacy },
    { server, client, legacy },
  ]) {
    settings.apps = apps;
    const { apps: loaded } = await load();
    assert.equal(loaded.length, 2);
    assert.equal(
      loaded.find(({ name }) => name === "client")?.folder,
      path.join(second, "owner", "app"),
    );
    assert.equal(loaded.find(({ name }) => name === "server")?.folder, firstOwner);
  }
});

test("Discover excludes helpers of saved Rslib owners behind ignored paths", async (t) => {
  const { root } = fixture(t);
  const owner = path.join(root, "library");
  const shared = path.join(root, "shared");
  fs.mkdirSync(owner);
  fs.mkdirSync(shared);
  fs.symlinkSync("library", path.join(root, "linked"), "dir");
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(
    path.join(shared, "module-federation.config.ts"),
    `export default { name: 'client' };`,
  );
  fs.writeFileSync(
    path.join(owner, "rslib.config.ts"),
    `import mf from '../shared/module-federation.config';
    export default { lib: [{ format: 'mf', plugins: [pluginModuleFederation(mf)] }] };`,
  );
  const settings: DashboardSettings = {
    apps: undefined,
    envMode: "development",
    ignorePaths: ["library"],
    extraManifestUrls: [],
    structure: "tree",
  };
  const session = new DashboardSession(
    {
      readSettings: () => settings,
      writeApps: () => assert.fail("Discover must not persist an owned helper"),
      scan: prepareWorkspaceScan,
      loadKnown: loadKnownApps,
      roots: () => [{ name: "root", path: root }],
      async probe() {},
    },
    createProbeBook(),
  );
  for (const folder of ["library", "linked"]) {
    settings.apps = { saved: { path: folder } };
    assert.deepEqual(session.prepareDiscovery(), []);
    await session.discover();
    assert.deepEqual(
      session.loaded.map(({ folder }) => folder),
      [path.join(root, folder)],
    );
  }
});

test("Discover tracks an inactive Rslib config in a workspace folder without apps", async (t) => {
  const { root, writeApp } = fixture(t);
  const web = path.dirname(writeApp("web"));
  const lib = path.join(root, "lib");
  fs.mkdirSync(lib);
  const config = path.join(lib, "rslib.config.ts");
  fs.writeFileSync(config, `export default { lib: [{ format: 'esm' }] };`);
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  const roots = [
    { name: "web", path: web },
    { name: "lib", path: lib },
  ];
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
      scan: prepareWorkspaceScan,
      loadKnown: loadKnownApps,
      roots: () => roots,
      async probe() {},
    },
    createProbeBook(),
  );
  await session.discover();
  assert.equal(session.loaded[0]?.folder, web);
  assert.ok(session.ownershipSources.has(config));
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

test("Discover does not save helpers imported by a configured Rslib start override", async (t) => {
  const { root } = fixture(t);
  const folder = path.join(root, "library");
  const shared = path.join(folder, "shared");
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(
    path.join(folder, "package.json"),
    '{"scripts":{"serve":"rslib mf-dev -c custom.ts"}}',
  );
  fs.writeFileSync(
    path.join(shared, "module-federation.config.ts"),
    `export default { name: 'library' };`,
  );
  fs.writeFileSync(
    path.join(folder, "custom.ts"),
    `
    import mf from './shared/module-federation.config';
    export default { lib: [{ format: 'mf', plugins: [pluginModuleFederation(mf)] }] };
  `,
  );
  const apps = { owner: { path: "library", scripts: { start: "serve" } } };
  const { session, values, writes } = await start(t, root, { "mf-dashboard.apps": apps });
  await session.discover();
  assert.deepEqual(values.get("mf-dashboard.apps"), apps);
  assert.equal(writes.includes("mf-dashboard.apps"), false);
  assert.deepEqual(
    session.loaded.map(({ folder }) => folder),
    [folder],
  );
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

test("the worker checks discovery imports again before probing", async (t) => {
  const { root, writeApp } = fixture(t);
  const config = writeApp("app");
  const helper = path.join(path.dirname(config), "port.ts");
  fs.writeFileSync(
    config,
    'import { port } from "./port"; export default { name: "app", server: { port } };',
  );
  fs.writeFileSync(helper, "export const port = 4180;");
  const current: DashboardSettings = {
    apps: undefined,
    envMode: "development",
    ignorePaths: [],
    extraManifestUrls: [],
    structure: "tree",
  };
  const worker = new KnownAppsWorker();
  t.after(() => worker.dispose());
  const session = new DashboardSession(
    {
      readSettings: () => current,
      writeApps(apps) {
        current.apps = apps;
      },
      scan: prepareWorkspaceScan,
      loadKnown: loadKnownApps,
      loadKnownAsync(roots, settings, log, discovery) {
        assert.ok(discovery?.parsed.size);
        fs.writeFileSync(helper, "export const port = 51101;");
        return worker.load({ roots, settings, discovery }, log);
      },
      roots: () => [{ name: "workspace", path: root }],
      async probe(_book, input) {
        assert.equal(input.apps[0]?.port, 51101);
      },
    },
    createProbeBook(),
  );
  await session.discover();
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
