import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fillTemplate, runShell } from "../src/shared/shell.ts";

test("placeholder values are one quoted shell word", () => {
  if (process.platform === "win32") {
    assert.equal(fillTemplate("echo {name}", { name: 'a&b"c' }), 'echo "a&b""c"');
  } else {
    assert.equal(fillTemplate("echo {name}", { name: "a; touch pwned" }), "echo 'a; touch pwned'");
    assert.equal(fillTemplate("echo {name}", { name: "a'b" }), "echo 'a'\\''b'");
  }
  assert.equal(fillTemplate("echo {missing}", {}), "echo {missing}");
});

test(
  "a timed out shell command stops its child process",
  { skip: process.platform === "win32" },
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mf-shell-"));
    try {
      writeFileSync(
        path.join(dir, "child.cjs"),
        'require("node:fs").writeFileSync("started", "yes"); setTimeout(() => require("node:fs").writeFileSync("marker", "done"), 800);',
      );
      await assert.rejects(runShell(`"${process.execPath}" child.cjs`, dir, 500), /timeout/);
      assert.equal(existsSync(path.join(dir, "started")), true);
      await new Promise((resolve) => setTimeout(resolve, 900));
      assert.equal(existsSync(path.join(dir, "marker")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
