import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import * as vscode from "./support/vscode.ts";
import { localApp } from "./support/app.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "vscode") {
      return { url: new URL("./support/vscode.ts", import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { TypesBuildView } = await import("../src/app/lib/types-build-view.ts");

test("no rebuild needed applies even to an app that only consumes types", async (t) => {
  const view = new TypesBuildView({ apps: [{ app: "catalog", status: "current" }] });
  t.after(() => view.dispose());
  view.setWorkspace(
    [localApp("catalog", "/catalog", { generateTypes: false, consumeTypes: true })],
    "tree",
  );

  const item = view.getTreeItem(view.getChildren()[0]);
  assert.equal(item.description, "No rebuild needed");
  assert.equal(item.tooltip, undefined);
  const report = t.mock.method(vscode.workspace, "openTextDocument");
  await view.openReport();
  assert.match(JSON.stringify(report.mock.calls[0]?.arguments[0]), /catalog — No rebuild needed/);
});

test("discovered apps can be rebuilt in either layout before the first workspace build", (t) => {
  const view = new TypesBuildView();
  t.after(() => view.dispose());
  const link = (name: string, port: number) => ({
    name,
    alias: name,
    url: `http://localhost:${port}/mf-manifest.json`,
  });
  const apps = [
    localApp("shell", "/shell", {
      consumeTypes: true,
      remotes: [link("catalog", 4101), link("shared", 4102), link("external", 4103)],
    }),
    localApp("catalog", "/catalog", {
      settingsKey: "old-catalog",
      port: 4101,
      consumeTypes: true,
      remotes: [link("shared", 4102)],
    }),
    localApp("shared", "/shared", {
      port: 4102,
      consumeTypes: true,
      remotes: [link("catalog", 4101)],
    }),
  ];
  view.setWorkspace(apps, "tree");
  const [shell] = view.getChildren();
  assert.equal(view.getChildren().length, 1);
  assert.equal(view.getTreeItem(shell).description, "Not built yet");
  const [catalog, shared] = view.getChildren(shell);
  assert.equal(view.getChildren(shell).length, 2);
  assert.equal(view.getTreeItem(shell).collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
  assert.equal(
    view.getTreeItem(catalog).collapsibleState,
    vscode.TreeItemCollapsibleState.Collapsed,
  );
  const [nestedShared] = view.getChildren(catalog);
  assert.notEqual(view.getTreeItem(shared).id, view.getTreeItem(nestedShared).id);
  assert.deepEqual(view.getChildren(view.getChildren(nestedShared)[0]), []);
  const target = view.targetFor(catalog);
  assert.deepEqual(target, { app: "catalog", settingsKey: "old-catalog" });
  view.update([{ app: "shared", status: "failed", reason: "Compiler failed" }]);
  view.start(target);
  view.update([{ ...target!, status: "rebuilt" }]);
  assert.equal(view.finish().apps.length, 2);
  assert.equal(view.getTreeItem(shared).description, "Failed");
  assert.equal(view.getTreeItem(nestedShared).description, "Failed");
  const [reason] = view.getChildren(shared);
  assert.equal(view.targetFor(reason), undefined);
  view.setWorkspace(apps, "flat");
  assert.deepEqual(
    view.getChildren().map((row) => view.getTreeItem(row).label),
    ["catalog (old-catalog)", "shared", "shell"],
  );
  const [flatCatalog] = view.getChildren();
  assert.deepEqual(view.getChildren(flatCatalog), []);
  assert.deepEqual(view.targetFor(flatCatalog), target);
  view.setWorkspace([], "tree");
  assert.equal(view.targetFor(flatCatalog), undefined);
});

test("the types tree follows the workspace hierarchy even when a consumer uses a staging URL", (t) => {
  const view = new TypesBuildView();
  t.after(() => view.dispose());
  view.setWorkspace(
    [
      localApp("catalog", "/catalog", { port: 4101 }),
      localApp("shell", "/shell", {
        consumeTypes: true,
        remotes: [
          { name: "catalog", alias: "catalog", url: "https://staging.example/mf-manifest.json" },
        ],
      }),
    ],
    "tree",
  );
  const [shell] = view.getChildren();
  assert.equal(view.getChildren().length, 1);
  assert.equal(view.getTreeItem(shell).label, "shell");
  const [catalog] = view.getChildren(shell);
  assert.equal(view.getTreeItem(catalog).label, "catalog");
  assert.equal(view.targetFor(catalog)?.app, "catalog");
});

test("the types tree keeps its rows across identical probes and updates only the app occurrences", (t) => {
  const view = new TypesBuildView();
  const events: unknown[] = [];
  t.after(() => view.dispose());
  view.onDidChangeTreeData((event) => events.push(event));
  const catalog = localApp("catalog", "/catalog");
  const remotes = [
    { name: "catalog", alias: "catalog", url: "http://localhost:4100/mf-manifest.json" },
  ];
  const apps = [
    catalog,
    localApp("admin", "/admin", { remotes }),
    localApp("shell", "/shell", { remotes }),
  ];
  view.setWorkspace(apps, "tree");
  const roots = view.getChildren();
  const occurrences = roots.map((row) => view.getChildren(row)[0]);
  events.length = 0;
  view.setWorkspace(structuredClone(apps), "tree");
  assert.deepEqual(events, []);
  assert.equal(view.getChildren()[0], roots[0]);
  view.update([{ app: "catalog", status: "running" }]);
  assert.deepEqual(events, [occurrences]);
  assert.deepEqual(
    occurrences.map((row) => view.getTreeItem(row).description),
    ["Updating", "Updating"],
  );
});

test("build view can reopen the report and keeps compiler Problems until the next run", async (t) => {
  let entries: [vscode.Uri, vscode.Diagnostic[]][] = [];
  t.mock.method(vscode.languages, "createDiagnosticCollection", () => ({
    set(value: typeof entries) {
      entries = value;
    },
    clear() {
      entries = [];
    },
    dispose() {},
  }));
  const document = t.mock.method(vscode.workspace, "openTextDocument");
  const view = new TypesBuildView();
  t.after(() => view.dispose());
  view.start();
  view.update([
    {
      app: "producer",
      status: "failed",
      reason: "Declaration emit failed",
      problems: [
        {
          file: "/apps/producer/source.ts",
          line: 7,
          column: 3,
          code: "TS2322",
          message: "Type mismatch",
        },
      ],
    },
    { app: "independent", status: "rebuilt" },
  ]);
  const snapshot = view.finish();
  assert.equal(entries[0][0].fsPath, "/apps/producer/source.ts");
  assert.deepEqual(entries[0][1][0].range.start, { line: 6, character: 2 });
  assert.equal(entries[0][1][0].code, "TS2322");
  assert.equal(entries[0][1][0].severity, vscode.DiagnosticSeverity.Error);
  const reopened = new TypesBuildView(snapshot);
  t.after(() => reopened.dispose());
  assert.deepEqual(
    reopened.getChildren().map((row) => reopened.getTreeItem(row).description),
    ["Rebuilt", "Failed"],
  );
  const children = reopened.getChildren(reopened.getChildren()[1]);
  const definition = reopened.getTreeItem(children[1]);
  assert.equal(definition.command?.command, "vscode.open");
  assert.equal(definition.command?.arguments?.[0].fsPath, "/apps/producer/source.ts");
  await reopened.openReport();
  const arg = document.mock.calls.at(-1)?.arguments[0] as unknown as { content: string };
  assert.match(arg.content, /producer — Failed[\s\S]*source.ts:7:3 TS2322 Type mismatch/);
  view.start();
  assert.deepEqual(entries, []);
});

test("the row action follows the workspace build plan for producers and consumers", (t) => {
  const view = new TypesBuildView();
  t.after(() => view.dispose());
  const remote = { name: "producer", alias: "p", url: "http://localhost:4100/mf-manifest.json" };
  const consumer = { generateTypes: false, consumeTypes: true };
  const apps = [
    localApp("producer", "/producer"),
    localApp("consumer", "/consumer", { ...consumer, remotes: [remote] }),
    localApp("mixed", "/mixed", { consumeTypes: true, remotes: [remote] }),
    localApp("external", "/external", {
      ...consumer,
      remotes: [{ ...remote, url: "https://example.org/mf-manifest.json" }],
    }),
    localApp("disabled", "/disabled", {
      generateTypes: false,
      consumeTypes: false,
      remotes: [remote],
    }),
    localApp("empty", "/empty", { hasExposes: false }),
  ];
  view.setWorkspace(apps, "flat");
  const tasks = new Map([
    ["producer", "package"],
    ["consumer", "arrow-down"],
    ["mixed", "arrow-swap"],
  ]);
  for (const row of view.getChildren()) {
    const item = view.getTreeItem(row);
    const planned = tasks.get(String(item.label));
    assert.equal(view.targetFor(row) !== undefined, !!planned, String(item.label));
    assert.equal(item.contextValue === "typesBuildApp", !!planned, String(item.label));
    assert.deepEqual(item.iconPath, new vscode.ThemeIcon(planned ?? "circle-slash"));
    assert.ok(item.accessibilityInformation?.label.startsWith(`${item.label}, Not built yet, `));
    if (!planned) assert.equal(item.tooltip, "No types to update");
  }
  view.update([{ app: "consumer", status: "failed" }]);
  assert.deepEqual(view.getTreeItem(view.getChildren()[0]).iconPath, new vscode.ThemeIcon("error"));
});

test("an unreadable config matches its settings key in both layouts and a restored report", (t) => {
  const problem = {
    file: "/catalog/mf.config.ts",
    line: 2,
    column: 3,
    message: "Unexpected token",
  };
  const issue = {
    app: "legacy",
    status: "skipped" as const,
    reason: "Config syntax error",
    problems: [problem],
  };
  const apps = [
    localApp("shell", "/shell", {
      consumeTypes: true,
      remotes: [
        { name: "catalog", alias: "catalog", url: "http://localhost:4101/mf-manifest.json" },
      ],
    }),
    localApp("catalog", "/catalog", { settingsKey: "legacy", port: 4101 }),
  ];
  const view = new TypesBuildView();
  t.after(() => view.dispose());
  view.setWorkspace(apps, "tree");
  view.update([issue]);
  const [nested] = view.getChildren(view.getChildren()[0]);
  assert.equal(view.getTreeItem(nested).description, "Skipped");
  const [reason, diagnostic] = view.getChildren(nested);
  assert.equal(view.getTreeItem(reason).label, issue.reason);
  assert.equal(view.getTreeItem(diagnostic).command?.command, "vscode.open");

  const restored = new TypesBuildView(view.finish());
  t.after(() => restored.dispose());
  restored.setWorkspace(apps, "flat");
  const [flat] = restored.getChildren();
  assert.equal(restored.getTreeItem(flat).label, "catalog (legacy)");
  assert.equal(restored.getTreeItem(flat).tooltip, issue.reason);
  restored.update([{ app: "previous-name", settingsKey: "legacy", status: "rebuilt" }]);
  assert.equal(restored.getTreeItem(flat).description, "Not built yet");
});

test("a build result for a changed federation name remains visible and has a distinct row id", (t) => {
  const view = new TypesBuildView();
  t.after(() => view.dispose());
  view.setWorkspace([localApp("beta", "/beta", { settingsKey: "b" })], "tree");
  view.update([{ app: "alpha", settingsKey: "b", status: "skipped", reason: "Duplicate name" }]);
  const [current, conflict] = view.getChildren();
  const item = view.getTreeItem(conflict);
  assert.notEqual(item.id, view.getTreeItem(current).id);
  assert.equal(item.label, "alpha (b)");
  assert.equal(item.description, "Skipped");
  assert.equal(item.tooltip, "Duplicate name");
  assert.equal(view.targetFor(conflict), undefined);
});

test("a renamed app keeps its own status beside an invalid configuration with the same name", (t) => {
  const view = new TypesBuildView();
  t.after(() => view.dispose());
  view.start();
  view.update([{ app: "catalog", status: "skipped", reason: "Config syntax error" }]);
  view.update([{ app: "catalog", settingsKey: "old-catalog", status: "rebuilt" }]);
  const saved = view.finish();
  assert.equal(saved.apps.length, 2);
  view.relabel((message) => (message === "Skipped" ? "Пропущено" : message));
  const rows = view.getChildren().map((row) => view.getTreeItem(row));
  assert.deepEqual(
    rows.map(({ id, description }) => [id, description]),
    [
      ["types:catalog", "Пропущено"],
      ["types:old-catalog", "Rebuilt"],
    ],
  );
});

test("the restored build error follows the current panel language", async (t) => {
  const document = t.mock.method(vscode.workspace, "openTextDocument");
  const view = new TypesBuildView({ apps: [], error: "Disk coordination failed" });
  t.after(() => view.dispose());
  view.relabel((message, detail) =>
    message.startsWith("Could not update") ? `Ошибка сборки: ${detail}` : message,
  );
  assert.equal(
    view.getTreeItem(view.getChildren()[0]).tooltip,
    "Ошибка сборки: Disk coordination failed",
  );
  await view.openReport();
  const arg = document.mock.calls.at(-1)?.arguments[0] as unknown as { content: string };
  assert.match(arg.content, /Ошибка сборки: Disk coordination failed/);
});
