import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
import {
  GRAPH_FILE,
  prepareWorkspaceGraphDirectories,
  readWorkspaceGraphs,
  workspaceGraphIsStale,
  writeWorkspaceGraphs,
} from "../src/widgets/mf-dashboard-tree/lib/workspace-graph.ts";
import { createLogger } from "../src/shared/lib/logging.ts";
import type {
  DashboardSettings,
  WorkspaceRoot,
} from "../src/widgets/mf-dashboard-tree/models/session-types.ts";
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
  root: string | readonly WorkspaceRoot[],
  initial: Record<string, unknown>,
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
  const roots = typeof root === "string" ? [{ name: "workspace", path: root }] : root;
  workspace.workspaceFolders = roots.map(({ name, path: folder }) => ({
    name,
    uri: stub.Uri.file(folder),
  }));
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
    channel.messages.some((message) => message.includes("refresh.completed")),
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
  await session.discover();
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

test("duplicate names leave the saved graph intact after a failed rescan", async (t) => {
  const { root, writeApp } = fixture(t);
  writeApp("first");
  const { session } = await start(t, root, {});
  await session.discover();
  const file = path.join(root, GRAPH_FILE);
  const before = fs.readFileSync(file, "utf8");
  fs.writeFileSync(writeApp("second"), "export default {name:'first'}");
  await assert.rejects(session.discover(), /duplicate federation name: first/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual(
    session.loaded.map(({ name }) => name),
    ["first"],
  );
});

test("refresh keeps the saved graph while an explicit build reports changed configurations", async (t) => {
  const { root, writeApp } = fixture(t);
  writeApp("alpha");
  const beta = writeApp("beta");
  const { session, typesView } = await start(t, root, {});
  await session.discover();
  fs.writeFileSync(beta, "export default {name:'alpha', dts:false}");
  const run = (name: string) => stub.registeredCommands.get(`mf-dashboard.${name}`)!();
  await run("refresh");
  assert.deepEqual(
    session.loaded.map(({ name }) => name),
    ["alpha", "beta"],
  );
  await run("rebuildAllTypes");
  const items = typesView.getChildren().map((row) => typesView.getTreeItem(row));
  const conflicts = items.filter((item) =>
    /Duplicate Module Federation name: alpha/.test(String(item.tooltip)),
  );
  assert.deepEqual(conflicts.map((item) => item.label).sort(), ["alpha", "alpha (beta)"]);
});

test("deleting the graph clears the types report, while clearing legacy settings keeps the graph", async (t) => {
  const { root, writeApp } = fixture(t);
  writeApp("widget");
  const context = t.mock.method(stub.commands, "executeCommand");
  const { session, values, changes, state, typesView } = await start(t, root, {
    "mf-dashboard.apps": { widget: { path: "widget" } },
  });
  await session.discover();
  const run = (name: string) => stub.registeredCommands.get(`mf-dashboard.${name}`)!();
  await run("rebuildAllTypes");
  assert.ok(state.get("mf-dashboard.lastTypesBuild"));
  values.delete("mf-dashboard.apps");
  changes.fire({
    affectsConfiguration: (key) => key === "mf-dashboard.apps",
  } as ConfigurationChangeEvent);
  await run("refresh");
  assert.deepEqual(
    session.loaded.map(({ name }) => name),
    ["widget"],
  );
  assert.ok(state.get("mf-dashboard.lastTypesBuild"));

  fs.unlinkSync(path.join(root, GRAPH_FILE));
  await run("refresh");
  const enabled = context.mock.calls
    .filter(
      ({ arguments: args }) =>
        args[0] === "setContext" && args[1] === "mf-dashboard.canUpdateTypes",
    )
    .at(-1)?.arguments[2];
  assert.equal(enabled, false);
  assert.equal(state.get("mf-dashboard.lastTypesBuild"), undefined);
  assert.deepEqual(typesView.getChildren(), []);
  await run("discover");
  const [widget] = typesView.getChildren();
  assert.equal(typesView.getTreeItem(widget).description, "Not built yet");
});

test("first open waits for Find and never seeds workspace settings", async (t) => {
  const { root, writeApp } = fixture(t);
  writeApp("first");
  const { session, channel, writes } = await start(t, root, {});
  assert.deepEqual(session.loaded, []);
  assert.equal(fs.existsSync(path.join(root, GRAPH_FILE)), false);
  assert.equal(
    channel.messages.some((line) => line.startsWith("discovery.scan.started")),
    false,
  );
  await stub.registeredCommands.get("mf-dashboard.discover")!();
  assert.deepEqual(
    session.loaded.map(({ name }) => name),
    ["first"],
  );
  assert.deepEqual(writes, []);
  assert.equal(
    channel.messages.filter((line) => line.startsWith("discovery.scan.started")).length,
    1,
  );
  assert.ok(fs.existsSync(path.join(root, GRAPH_FILE)));
});

test("a local graph cold-loads without scanning or requiring legacy app settings", async (t) => {
  const { root, writeApp } = fixture(t);
  const config = writeApp("configured");
  const roots = [{ name: "workspace", path: root }];
  const settings: DashboardSettings = {
    apps: undefined,
    envMode: "development",
    ignorePaths: [],
    extraManifestUrls: [],
    structure: "tree",
  };
  await prepareWorkspaceGraphDirectories(roots);
  await writeWorkspaceGraphs(
    roots,
    settings,
    { configured: { path: "configured" } },
    Object.values(scanWorkspace(root)),
    new Set(),
    () => true,
  );
  fs.writeFileSync(config, "export default {name:'edited'}");
  writeApp("new-app");

  const { session, writes, channel } = await start(t, root, {});
  assert.deepEqual(
    session.loaded.map(({ name }) => name),
    ["configured"],
  );
  assert.deepEqual(writes, []);
  for (let i = 0; i < 100 && !session.graphStale; i++)
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.equal(session.graphStale, true);
  assert.equal(
    channel.messages.some((line) => line.startsWith("discovery.scan.started")),
    false,
  );
  await session.discover();
  assert.deepEqual(
    session.loaded.map(({ name }) => name),
    ["edited", "new-app"],
  );
});

test("a saved graph resolves paths in another checkout and rejects paths outside it", async (t) => {
  const original = fixture(t);
  original.writeApp("catalog");
  const roots = [{ name: "original", path: original.root }];
  const settings: DashboardSettings = {
    apps: undefined,
    envMode: "development",
    ignorePaths: [],
    extraManifestUrls: [],
    structure: "tree",
  };
  await prepareWorkspaceGraphDirectories(roots);
  await writeWorkspaceGraphs(
    roots,
    settings,
    {},
    Object.values(scanWorkspace(original.root)),
    new Set(),
    () => true,
  );
  const clone = fixture(t);
  fs.cpSync(original.root, clone.root, { recursive: true });
  const copiedRoots = [{ name: "clone", path: clone.root }];
  const { apps, settings: selections } = await readWorkspaceGraphs(copiedRoots, noLog);
  assert.equal(apps[0]?.folder, path.join(clone.root, "catalog"));
  assert.equal(selections.catalog.workspaceFolder, "clone");

  const file = path.join(clone.root, GRAPH_FILE);
  const graph = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.symlinkSync(original.root, path.join(clone.root, "outside"), "dir");
  graph.apps[0].folder = "outside/catalog";
  fs.writeFileSync(file, JSON.stringify(graph));
  const rejected = await readWorkspaceGraphs(copiedRoots, noLog);
  assert.deepEqual(rejected.apps, []);
  assert.equal(rejected.incomplete, true);
});

test("Find preserves computed URLs in an ignored graph and reindexes after edits to local dotenv", async (t) => {
  const { root, writeApp } = fixture(t);
  execFileSync("git", ["init", "-q"], { cwd: root });
  const folder = path.dirname(writeApp("shell"));
  fs.writeFileSync(
    path.join(folder, "module-federation.config.ts"),
    [
      'const local = "http://127.0.0.1:43113";',
      'export default {name:"shell", remotes: {',
      "  catalog: `catalog@${import.meta.env.CATALOG_URL}/${import.meta.env.ROUTE}/mf-manifest.json`,",
      "  repo: `repo@${local}/mf-manifest.json`,",
      "}};",
    ].join("\n"),
  );
  const env = path.join(folder, ".env.development.local");
  const firstHost = "http://127.0.0.1:43110";
  fs.writeFileSync(env, `OTHER_URL=${firstHost}\nCATALOG_URL=${firstHost}\nROUTE=fixture-path`);
  const { session, channel } = await start(t, root, {});
  await session.discover();
  const file = path.join(root, GRAPH_FILE);
  const graph = fs.readFileSync(file, "utf8");
  assert.equal(graph.includes(root), false);
  assert.doesNotMatch(graph, /OTHER_URL|CATALOG_URL|launchEnvironment/);
  assert.equal(
    execFileSync("git", ["check-ignore", GRAPH_FILE], { cwd: root, encoding: "utf8" }).trim(),
    GRAPH_FILE,
  );
  assert.equal(fs.existsSync(path.join(root, ".gitignore")), false);
  assert.deepEqual(session.loaded[0].remotes, [
    { name: "catalog", alias: "catalog", url: `${firstHost}/fixture-path/mf-manifest.json` },
    { name: "repo", alias: "repo", url: "http://127.0.0.1:43113/mf-manifest.json" },
  ]);

  const nextHost = "http://127.0.0.1:43111";
  fs.writeFileSync(env, `OTHER_URL=${firstHost}\nCATALOG_URL=${nextHost}\nROUTE=updated-path`);
  await session.refresh();
  assert.equal(session.loaded[0].remotes[0].url, `${firstHost}/fixture-path/mf-manifest.json`);
  assert.equal(fs.readFileSync(file, "utf8"), graph);
  for (let i = 0; i < 100 && !session.graphStale; i++)
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.equal(session.graphStale, true);
  assert.equal(
    channel.messages.filter((line) => line.startsWith("discovery.scan.started")).length,
    1,
  );
  await session.discover();
  assert.equal(session.loaded[0].remotes[0].url, `${nextHost}/updated-path/mf-manifest.json`);
});

test("graph initialization preserves existing ignore rules and refuses a tracked graph", async (t) => {
  const { root } = fixture(t);
  const roots = [{ name: "workspace", path: root }];
  execFileSync("git", ["init", "-q"], { cwd: root });
  fs.mkdirSync(path.join(root, ".mf-dashboard"));
  const ignore = path.join(root, ".mf-dashboard/.gitignore");
  fs.writeFileSync(ignore, "# Team notes\n/notes.json");
  await prepareWorkspaceGraphDirectories(roots);
  const contents = fs.readFileSync(ignore, "utf8");
  assert.match(contents, /^# Team notes\n\/notes\.json\n/);
  await prepareWorkspaceGraphDirectories(roots);
  assert.equal(fs.readFileSync(ignore, "utf8"), contents);
  fs.writeFileSync(path.join(root, GRAPH_FILE), "{}");
  execFileSync("git", ["add", "-f", "--", GRAPH_FILE], { cwd: root });
  await assert.rejects(prepareWorkspaceGraphDirectories(roots), /is tracked by Git/);
});

test("Find retains a migrated explicit config after a temporary syntax error", async (t) => {
  const { root } = fixture(t);
  const config = path.join(root, "custom.ts");
  const valid = 'export default {name:"configured", dts:false};';
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(config, valid);
  const { session, values } = await start(t, root, {
    "mf-dashboard.apps": { configured: { path: ".", configFile: "custom.ts" } },
  });
  await session.discover();
  assert.equal(session.loaded[0]?.name, "configured");
  values.delete("mf-dashboard.apps");
  fs.writeFileSync(config, "export default {");
  await session.discover();
  assert.equal(session.loaded.length, 0);
  assert.equal(session.workspaceGraph?.overrides.configured.configFile, "custom.ts");
  assert.deepEqual(Object.keys(session.workspaceGraph?.settings ?? {}), []);
  await session.refresh();

  fs.writeFileSync(config, valid);
  await session.discover();
  assert.equal(session.loaded[0]?.name, "configured");
  assert.equal(session.workspaceGraph?.settings.configured.configFile, "custom.ts");
});

test("Find can recover an unresolved unscoped override in another workspace root", async (t) => {
  const first = fixture(t);
  const second = fixture(t);
  first.writeApp("shell");
  const roots = [
    { name: "first", path: first.root },
    { name: "second", path: second.root },
  ];
  for (const { path: root } of roots) {
    fs.mkdirSync(path.join(root, "widget"));
    fs.writeFileSync(path.join(root, "widget/custom.ts"), "export default {");
  }
  const override = { path: "widget", configFile: "custom.ts" };
  const { session, values } = await start(t, roots, {
    "mf-dashboard.apps": { widget: override },
  });
  await session.discover();
  assert.deepEqual(session.workspaceGraph?.overrides.widget, override);
  values.delete("mf-dashboard.apps");
  await session.refresh();

  fs.writeFileSync(
    path.join(second.root, "widget/custom.ts"),
    'export default {name:"widget", dts:false};',
  );
  assert.equal(
    await workspaceGraphIsStale(session.workspaceGraph!, {
      apps: undefined,
      envMode: "development",
      ignorePaths: [],
      extraManifestUrls: [],
      structure: "tree",
    }),
    true,
  );
  await session.discover();
  assert.equal(
    session.loaded.find(({ name }) => name === "widget")?.folder,
    path.join(second.root, "widget"),
  );
  assert.equal(session.workspaceGraph?.settings.widget.workspaceFolder, "second");
});

test("a ZIP override preserves whitespace in the file name after Find", async (t) => {
  const { root, writeApp } = fixture(t);
  const config = writeApp("widget");
  const valid = fs.readFileSync(config, "utf8");
  const folder = path.dirname(config);
  const zip = path.join(folder, " types.zip ");
  fs.writeFileSync(zip, "types archive");
  fs.writeFileSync(config, "export default {");
  const { session, values } = await start(t, root, {
    "mf-dashboard.apps": { widget: { path: "widget", typesZipPath: "./ types.zip /." } },
  });

  await session.discover();
  const unresolved = session.workspaceGraph?.overrides.widget.typesZipPath;
  assert.ok(unresolved);
  assert.equal(path.resolve(folder, unresolved.trim()), zip);

  values.delete("mf-dashboard.apps");
  fs.writeFileSync(config, valid);
  await session.discover();
  const resolved = session.workspaceGraph?.settings.widget.typesZipPath;
  assert.ok(resolved);
  assert.equal(fs.readFileSync(path.resolve(folder, resolved.trim()), "utf8"), "types archive");
});

test("editing an inactive standard config invalidates the graph", async (t) => {
  const { root, writeApp } = fixture(t);
  writeApp("shell");
  const config = writeApp("widget");
  const valid = fs.readFileSync(config, "utf8");
  fs.writeFileSync(config, "export default {};");
  const { session } = await start(t, root, {});
  const settings: DashboardSettings = {
    apps: undefined,
    envMode: "development",
    ignorePaths: [],
    extraManifestUrls: [],
    structure: "tree",
  };

  await session.discover();
  assert.deepEqual(
    session.loaded.map(({ name }) => name),
    ["shell"],
  );
  assert.equal(await workspaceGraphIsStale(session.workspaceGraph!, settings), false);
  fs.writeFileSync(config, valid);
  assert.equal(await workspaceGraphIsStale(session.workspaceGraph!, settings), true);
  await session.discover();
  assert.deepEqual(
    session.loaded.map(({ name }) => name),
    ["shell", "widget"],
  );
});

test("a launcher with a custom config invalidates the graph without AST parsing", async (t) => {
  const { root, writeApp } = fixture(t);
  writeApp("shell");
  const { session } = await start(t, root, {});
  await session.discover();
  const settings: DashboardSettings = {
    apps: undefined,
    envMode: "development",
    ignorePaths: [],
    extraManifestUrls: [],
    structure: "tree",
  };
  const folder = path.join(root, "new-package");
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "package.json"), "{}");
  assert.equal(await workspaceGraphIsStale(session.workspaceGraph!, settings), false);

  fs.writeFileSync(
    path.join(folder, "package.json"),
    '{"scripts":{"dev":"rsbuild dev --config custom.ts"}}',
  );
  assert.equal(await workspaceGraphIsStale(session.workspaceGraph!, settings), true);
  await session.discover();
  assert.deepEqual(
    session.loaded.map(({ name }) => name),
    ["shell"],
  );
  fs.writeFileSync(
    path.join(folder, "custom.ts"),
    'export default {plugins:[pluginModuleFederation({name:"newApp"})]};',
  );
  assert.equal(await workspaceGraphIsStale(session.workspaceGraph!, settings), true);
  await session.discover();
  assert.deepEqual(
    session.loaded.map(({ name }) => name),
    ["newApp", "shell"],
  );
});

test("rebuild from the main tree resolves the configured launcher environment again", async (t) => {
  const { root } = fixture(t);
  fs.mkdirSync(path.join(root, "env"));
  fs.writeFileSync(path.join(root, "env/.env.review"), "MODE_VALUE=fixture");
  fs.writeFileSync(path.join(root, "tsconfig.json"), '{"include":["index.ts"]}');
  fs.writeFileSync(path.join(root, "index.ts"), "export type Example = string;");
  fs.writeFileSync(
    path.join(root, "package.json"),
    '{"scripts":{"dev":"rslib mf-dev --env-dir env --env-mode review"}}',
  );
  fs.writeFileSync(
    path.join(root, "rslib.config.ts"),
    'export default { lib: [{ format: "mf", plugins: [pluginModuleFederation({ name: "library", exposes: { ".": "./index.ts" }, dts: true })] }] };',
  );
  const { session, dashboard } = await start(t, root, {});
  await session.discover();
  assert.equal(session.loaded[0]?.launchEnvironment, undefined);
  const request = t.mock.method(KnownAppsWorker.prototype, "request");
  await dashboard.rebuild(dashboard.getChildren()[0]);
  const resolve = request.mock.calls.find(({ arguments: args }) => args[0] === "rebuild");
  assert.ok(resolve);
  const resolved = (await resolve.result) as Awaited<
    ReturnType<
      typeof import("../src/widgets/mf-dashboard-tree/lib/rebuild-apps.ts").resolveRebuildApps
    >
  >;
  assert.equal(resolved.apps[0]?.launchEnvironment?.envMode, "review");
  assert.equal(resolved.apps[0]?.launchEnvironment?.env.MODE_VALUE, "fixture");
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
      0,
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
  assert.deepEqual(values.get("mf-dashboard.apps"), { nested: saved });
  assert.equal(session.workspaceGraph?.settings.nested.path, "z-launch");
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
  assert.deepEqual(values.get("mf-dashboard.apps"), { oldName: saved });
  assert.equal(session.workspaceGraph?.settings.nested.path, "z-launch");
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
  assert.deepEqual(values.get("mf-dashboard.apps"), { broken: null });
  assert.equal(session.workspaceGraph?.settings.nested.path, "z-launch");
  assert.deepEqual(
    session.loaded.map(({ settingsKey }) => settingsKey),
    ["nested"],
  );

  const ambiguousAliases = { first: { path: "z-launch" }, second: { path: "z-launch" } };
  values.set("mf-dashboard.apps", ambiguousAliases);
  await session.discover();
  assert.deepEqual(values.get("mf-dashboard.apps"), ambiguousAliases);
  assert.equal(session.workspaceGraph?.settings.nested.path, "z-launch");
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

test("Find updates helper ownership through a sibling Rslib launcher's custom config", async (t) => {
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
  await session.discover();
  assert.equal(session.loaded[0]?.settingsKey, "legacy");

  fs.writeFileSync(
    launcherPackage,
    '{"scripts":{"dev":"rslib mf-dev --root ../project --config ../custom.ts"}}',
  );
  await session.refresh("timer");
  assert.equal(session.loaded[0]?.settingsKey, "legacy");
  await session.discover();
  assert.deepEqual(
    session.loaded.map(({ settingsKey, folder }) => [settingsKey, folder]),
    [["designKit", path.join(root, "project")]],
  );

  fs.writeFileSync(launcherPackage, "{}");
  await session.discover();
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
