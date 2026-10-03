import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  diagnosticUpdates,
  extraManifestSettingsFile,
  problemDraft,
  problemSeverity,
} from "../src/entities/status/problems.ts";

test("extra manifest diagnostics follow the workspace value", () => {
  const folder = "/app";
  const workspace = "/app.code-workspace";
  const settingsFile = path.join(folder, ".vscode", "settings.json");
  assert.equal(
    extraManifestSettingsFile({
      workspaceValueDefined: true,
      workspaceFile: null,
      singleFolderPath: folder,
    }),
    settingsFile,
  );
  assert.equal(
    extraManifestSettingsFile({
      workspaceValueDefined: true,
      workspaceFile: { scheme: "file", fsPath: workspace },
      singleFolderPath: folder,
    }),
    workspace,
  );
  assert.equal(
    extraManifestSettingsFile({
      workspaceValueDefined: true,
      workspaceFile: { scheme: "file", fsPath: workspace },
      singleFolderPath: null,
    }),
    workspace,
  );
  assert.equal(
    extraManifestSettingsFile({
      workspaceValueDefined: false,
      workspaceFile: { scheme: "file", fsPath: workspace },
      singleFolderPath: folder,
    }),
    null,
  );
});

test("an untitled workspace does not fall back to folder settings", () => {
  assert.equal(
    extraManifestSettingsFile({
      workspaceValueDefined: true,
      workspaceFile: { scheme: "untitled", fsPath: "1555503116870" },
      singleFolderPath: "/app",
    }),
    null,
  );
});

test("warning and information kinds", () => {
  assert.equal(problemSeverity("invalidUrl"), "warning");
  assert.equal(problemSeverity("otherHost"), "warning");
  assert.equal(problemSeverity("otherPort"), "warning");
  assert.equal(problemSeverity("noAnswer"), "warning");
  assert.equal(problemSeverity("stale"), "information");
  assert.equal(problemSeverity("unfetched"), "information");
  assert.equal(problemSeverity("listen"), null);
  assert.equal(problemSeverity("silent"), null);
  assert.equal(problemSeverity("answers"), null);
});

test("a link draft names the consumer and the alias", () => {
  assert.deepEqual(
    problemDraft({
      kind: "unfetched",
      surface: "link",
      owner: "shell",
      alias: "widget",
      label: "types not updated",
      file: "/apps/shell/module-federation.config.ts",
    }),
    {
      file: "/apps/shell/module-federation.config.ts",
      message: "shell → widget: types not updated",
      severity: "information",
      kind: "unfetched",
    },
  );
});

test("an extra draft uses the host label", () => {
  assert.deepEqual(
    problemDraft({
      kind: "noAnswer",
      surface: "extra",
      owner: "static.example",
      alias: null,
      label: "unreachable",
      file: "/.vscode/settings.json",
    })?.message,
    "static.example: unreachable",
  );
});

test("a healthy kind or a missing file produces nothing", () => {
  assert.equal(
    problemDraft({
      kind: "listen",
      surface: "link",
      owner: "shell",
      alias: "widget",
      label: "listening",
      file: "/apps/shell/module-federation.config.ts",
    }),
    null,
  );
  assert.equal(
    problemDraft({
      kind: "invalidUrl",
      surface: "extra",
      owner: "external",
      alias: null,
      label: "URL error",
      file: null,
    }),
    null,
  );
  assert.equal(
    problemDraft({
      kind: "invalidUrl",
      surface: "extra",
      owner: "external",
      alias: null,
      label: "URL error",
      file: "  ",
    }),
    null,
  );
});

test("a replaced file list drops diagnostics that are gone", () => {
  assert.deepEqual(diagnosticUpdates(["/a", "/b"], ["/b", "/c"]), [
    { file: "/b", present: true },
    { file: "/c", present: true },
    { file: "/a", present: false },
  ]);
  assert.deepEqual(diagnosticUpdates(["/a"], []), [{ file: "/a", present: false }]);
  assert.deepEqual(diagnosticUpdates([], []), []);
});
