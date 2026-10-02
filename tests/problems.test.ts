import assert from "node:assert/strict";
import { test } from "node:test";
import {
  diagnosticUpdates,
  problemDraft,
  problemSeverity,
} from "../src/entities/status/problems.ts";

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
      file: "/repo/apps/shell/module-federation.config.ts",
    }),
    {
      file: "/repo/apps/shell/module-federation.config.ts",
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
      file: "/repo/.vscode/settings.json",
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
      file: "/repo/apps/shell/module-federation.config.ts",
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
