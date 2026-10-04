import { createLogger } from "../src/shared/logging.ts";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { localApp } from "./support/app.ts";
import { putAppResult } from "../src/entities/microfrontend/index.ts";
import * as vscode from "./support/vscode.ts";
import { terms, type DashboardTerms } from "../src/shared/config/index.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "vscode") {
      return { url: new URL("./support/vscode.ts", import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { linkRowId } = await import("../src/widgets/mf-dashboard-tree/presentation.ts");
const { MfDashboardProvider } = await import("../src/widgets/mf-dashboard-tree/provider.ts");

const workspace = vscode.workspace as typeof vscode.workspace & {
  workspaceFolders?: { name: string; uri: vscode.Uri }[];
  workspaceFile?: { scheme: string; fsPath: string } | null;
};

type Provider = InstanceType<typeof MfDashboardProvider>;

function providerFor(events?: { level: string; text: string }[]): Provider {
  const log = events
    ? createLogger({
        enabled: (level) => level === "info" || level === "warn" || level === "error",
        write: (level, text) => events.push({ level, text }),
      })
    : undefined;
  const provider = new MfDashboardProvider(() => terms, undefined, undefined, log);
  return provider;
}

function countBuilds(provider: Provider): { count: number } {
  const state = { count: 0 };
  const original = provider.session.nodes.bind(provider.session);
  provider.session.nodes = () => {
    state.count += 1;
    return original();
  };
  return state;
}

function useWorkspace(root: string, apps: Record<string, { path: string }>): () => void {
  const previous = {
    getConfiguration: vscode.workspace.getConfiguration,
    folders: workspace.workspaceFolders,
    file: workspace.workspaceFile,
  };
  workspace.workspaceFolders = [{ name: "workspace", uri: vscode.Uri.file(root) }];
  workspace.workspaceFile = null;
  vscode.workspace.getConfiguration = (() => ({
    async update() {},
    inspect(key: string) {
      if (key === "apps") return { workspaceValue: apps };
      return undefined;
    },
    get(key: string) {
      if (key === "structure") return "tree";
      if (key === "envMode") return "development";
      return undefined;
    },
  })) as unknown as typeof vscode.workspace.getConfiguration;
  return () => {
    vscode.workspace.getConfiguration = previous.getConfiguration;
    workspace.workspaceFolders = previous.folders;
    workspace.workspaceFile = previous.file;
  };
}

function writeApp(folder: string, name: string, remotes: string): void {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(folder, "module-federation.config.ts"),
    `export default { name: ${JSON.stringify(name)}, remotes: { ${remotes} } };`,
  );
}

test("a successful refresh builds the tree once for logs and later row requests", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-tree-render-"));
  const shell = path.join(root, "shell");
  writeApp(shell, "shell", 'widget: "widget"');
  const events: { level: string; text: string }[] = [];
  const provider = providerFor(events);
  const restore = useWorkspace(root, { shell: { path: "shell" } });
  const builds = countBuilds(provider);
  t.after(() => {
    restore();
    provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await provider.refresh();
  const roots = provider.getChildren();
  const child = roots[0]?.children[0];
  assert.ok(child);
  provider.getChildren(child);
  provider.getChildren();
  assert.equal(builds.count, 1);
  assert.deepEqual(
    roots.map((row) => [row.name, row.kind, row.description]),
    [["shell", "silent", "stopped"]],
  );
  assert.deepEqual(
    [child.name, child.kind, child.description],
    ["widget", "invalidUrl", "URL error"],
  );
  assert.deepEqual(provider.session.problemDrafts(null), [
    {
      file: path.join(shell, "module-federation.config.ts"),
      message: "shell → widget: URL error",
      severity: "warning",
      kind: "invalidUrl",
    },
  ]);
  const statusEvents = () => events.filter((event) => event.text.includes("status.changed"));
  assert.equal(statusEvents().length, 2);
  const after = statusEvents().length;
  provider.getChildren();
  provider.getChildren(child);
  assert.equal(statusEvents().length, after);
  assert.equal(provider.getChildren(), roots);
  const stat = t.mock.method(fs, "statSync");
  const read = t.mock.method(fs, "readFileSync");
  const statBefore = stat.mock.callCount();
  const readBefore = read.mock.callCount();
  const built = builds.count;
  provider.getChildren();
  provider.getChildren(child);
  assert.equal(builds.count, built);
  assert.equal(read.mock.callCount(), readBefore);
  assert.equal(stat.mock.callCount() - statBefore, 2);
});

test("flat row reads skip hidden remote types paths and tree mode sees their changes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-tree-flat-"));
  const folder = path.join(root, "shell");
  const typesRoot = path.join(folder, "@mf-types");
  fs.mkdirSync(typesRoot, { recursive: true });
  const provider = providerFor();
  provider.session.loaded = [
    localApp("shell", folder, {
      remotes: [{ alias: "widget", name: "widget", url: null }],
    }),
  ];
  t.after(() => {
    provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  provider.setStructure("flat");
  const rows = provider.getChildren();
  assert.equal(rows[0]?.children.length, 0);
  fs.mkdirSync(path.join(typesRoot, "widget"));
  const stat = t.mock.method(fs, "statSync");
  assert.equal(provider.getChildren(), rows);
  assert.deepEqual(
    stat.mock.calls.map((call) => call.arguments[0]),
    [typesRoot],
  );
  provider.setStructure("tree");
  const link = provider.getChildren()[0]?.children[0];
  assert.ok(link);
  assert.ok(link.contextValue.split(" ").includes("types"));
});

test("language, structure, pending, and script gaps rebuild the visible rows", () => {
  const provider = providerFor();
  provider.session.loaded = [
    localApp("shell", "/shell", {
      port: null,
      remotes: [{ alias: "widget", name: "widget", url: null }],
    }),
    localApp("widget", "/widget", { port: null }),
  ];
  const first = provider.getChildren();
  assert.equal(first[0]?.children.length, 1);
  const quiet: DashboardTerms = { ...terms, silent: "QUIET", invalidUrl: "BAD" };
  provider.relabel(quiet);
  assert.equal(provider.getChildren()[0]?.description, "QUIET");
  assert.equal(provider.getChildren()[0]?.children[0]?.description, "BAD");
  provider.setStructure("flat");
  assert.equal(provider.getChildren()[0]?.children.length, 0);
  provider.setStructure("tree");
  const linkId = linkRowId({ consumer: "shell", alias: "widget", remoteName: "widget" });
  provider.session.failRefetch(linkId);
  assert.match(provider.getChildren()[0]?.children[0]?.tooltip ?? "", /types download failed/);
  assert.equal(provider.session.refetch(linkId), true);
  assert.equal(
    provider.getChildren()[0]?.children[0]?.tooltip.includes("types download failed"),
    false,
  );
  provider.session.releaseRefetch(linkId);
  provider.session.noteScriptMissing("shell");
  assert.match(provider.getChildren()[0]?.tooltip ?? "", /script not found/);
  provider.session.noteRebuildError("shell", "rebuild failed");
  assert.match(provider.getChildren()[0]?.tooltip ?? "", /rebuild failed/);
  const widget = provider.session.loaded.find((app) => app.name === "widget");
  assert.ok(widget);
  widget.port = 4100;
  putAppResult(provider.session.book, "widget", {
    portOpen: true,
    manifestReachable: false,
    buildVersion: null,
    zipUrl: null,
    zipMtime: null,
    zipHash: null,
    exposes: [],
    shared: [],
  });
  provider.session.typesForLink = () => "unfetched";
  const pendingId = linkRowId({ consumer: "shell", alias: "widget", remoteName: "widget" });
  assert.equal(provider.session.refetch(pendingId), true);
  assert.match(provider.getChildren()[0]?.children[0]?.contextValue ?? "", /unfetched\.pending/);
  provider.session.releaseRefetch(pendingId);
  assert.equal(provider.getChildren()[0]?.children[0]?.contextValue.includes("pending"), false);
  provider.dispose();
});

test("a types directory change updates Reveal types without a new probe", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-tree-types-"));
  const folder = path.join(root, "shell");
  fs.mkdirSync(folder);
  const provider = providerFor();
  const builds = countBuilds(provider);
  provider.session.loaded = [
    localApp("shell", folder, {
      remotes: [{ alias: "widget", name: "widget", url: null }],
    }),
  ];
  const typesRoot = path.join(folder, "@mf-types");
  const linkTypes = path.join(typesRoot, "widget");
  const hasTypes = (rowIndex: 0 | 1) => {
    const row = provider.getChildren()[0];
    const node = rowIndex === 0 ? row : row?.children[0];
    return node?.contextValue.split(" ").includes("types") ?? false;
  };
  try {
    assert.equal(hasTypes(0), false);
    assert.equal(hasTypes(1), false);
    const built = builds.count;
    fs.writeFileSync(typesRoot, "not a directory");
    assert.equal(hasTypes(0), false);
    fs.rmSync(typesRoot);
    fs.mkdirSync(typesRoot);
    assert.equal(hasTypes(0), true);
    assert.equal(hasTypes(1), false);
    fs.mkdirSync(linkTypes);
    assert.equal(hasTypes(1), true);
    fs.rmSync(linkTypes, { recursive: true });
    assert.equal(hasTypes(1), false);
    fs.rmSync(typesRoot, { recursive: true });
    assert.equal(hasTypes(0), false);
    assert.ok(builds.count > built);
    const warm = builds.count;
    provider.getChildren();
    provider.getChildren();
    assert.equal(builds.count, warm);
  } finally {
    provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed refresh keeps the previous rows", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-tree-rollback-"));
  const shell = path.join(root, "shell");
  const other = path.join(root, "other");
  writeApp(shell, "shell", "");
  writeApp(other, "shell", "");
  const provider = providerFor();
  const restore = useWorkspace(root, { shell: { path: "shell" } });
  t.after(() => {
    restore();
    provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await provider.refresh();
  assert.equal(provider.getChildren()[0]?.name, "shell");
  restore();
  const restoreDuplicate = useWorkspace(root, {
    shell: { path: "shell" },
    other: { path: "other" },
  });
  t.after(restoreDuplicate);
  await assert.rejects(() => provider.refresh(), /duplicate federation name/);
  assert.equal(provider.getChildren()[0]?.name, "shell");
  assert.equal(provider.session.loaded.length, 1);
});

test("saving a source and the settle timer each rebuild the tree once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-tree-save-"));
  const folder = path.join(root, "shell");
  fs.mkdirSync(folder);
  const source = path.join(folder, "index.ts");
  fs.writeFileSync(source, "export const value = 1;\n");
  const provider = providerFor();
  const builds = countBuilds(provider);
  provider.session.loaded = [localApp("shell", folder, { tsconfig: null })];
  t.after(() => {
    provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  provider.getChildren();
  const baseline = builds.count;
  await provider.fileSaved(source);
  provider.getChildren();
  assert.equal(builds.count, baseline + 1);
  t.mock.timers.tick(15_000);
  provider.getChildren();
  assert.equal(builds.count, baseline + 2);
});

test("a structure change during a probe updates the rows without logging staged status", () => {
  const events: { level: string; text: string }[] = [];
  const provider = providerFor(events);
  provider.session.loaded = [
    localApp("shell", "/shell", {
      port: null,
      remotes: [{ alias: "widget", name: "widget", url: null }],
    }),
  ];
  provider.getChildren();
  const before = events.filter((event) => event.text.includes("status.changed")).length;
  provider.session.probeRunning = true;
  provider.setStructure("flat");
  assert.equal(provider.getChildren()[0]?.children.length, 0);
  assert.equal(events.filter((event) => event.text.includes("status.changed")).length, before);
  provider.session.probeRunning = false;
  provider.dispose();
});

test("logging off stays quiet across a rebuild and a repeated read", () => {
  const events: string[] = [];
  const provider = new MfDashboardProvider(
    () => terms,
    undefined,
    undefined,
    createLogger({
      enabled: () => false,
      write: (_level, text) => events.push(text),
    }),
  );
  provider.session.loaded = [localApp("shell", "/shell", { port: null })];
  provider.relabel(terms);
  provider.getChildren();
  provider.relabel(terms);
  assert.deepEqual(events, []);
  provider.dispose();
});

test("a shared link logs one status change when the same remote is reached through a cycle", () => {
  const events: { level: string; text: string }[] = [];
  const provider = providerFor(events);
  provider.session.loaded = [
    localApp("shell", "/shell", {
      remotes: [{ alias: "widget", name: "widget", url: null }],
    }),
    localApp("widget", "/widget", {
      remotes: [{ alias: "shell", name: "shell", url: null }],
    }),
  ];
  provider.relabel(terms);
  const changes = events.filter((event) => event.text.includes("status.changed"));
  const aliases = changes.map((event) => event.text.match(/alias=([^\s]+)/)?.[1] ?? "");
  assert.deepEqual(aliases.filter((alias) => alias !== "").sort(), ["shell", "widget"]);
  const again = changes.length;
  provider.relabel(terms);
  provider.getChildren();
  assert.equal(events.filter((event) => event.text.includes("status.changed")).length, again);
  provider.dispose();
});
