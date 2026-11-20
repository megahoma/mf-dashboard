import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import * as vscode from "./support/vscode.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "vscode") {
      return { url: new URL("./support/vscode.ts", import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { TypesBuildView } = await import("../src/app/lib/types-build-view.ts");

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
