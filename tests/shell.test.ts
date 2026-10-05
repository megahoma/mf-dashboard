import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fillTemplate, runShell } from "../src/shared/shell.ts";
import { safeError } from "../src/shared/logging.ts";
import { createSerialQueue } from "../src/shared/queue.ts";

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
      await assert.rejects(
        runShell(`"${process.execPath}" child.cjs`, dir, 500),
        (error: unknown) => {
          assert.equal(safeError(error).stage, "shell");
          assert.equal(safeError(error).reason, "timeout");
          assert.equal(safeError(error).timeoutMs, 500);
          return true;
        },
      );
      assert.equal(existsSync(path.join(dir, "started")), true);
      await new Promise((resolve) => setTimeout(resolve, 900));
      assert.equal(existsSync(path.join(dir, "marker")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("normal shell exit returns the actual exit code", async () => {
  assert.equal(await runShell(`"${process.execPath}" -e "process.exit(7)"`, tmpdir(), 5000), 7);
});

test(
  "timeout waits for SIGKILL when the generator or its descendant ignores SIGTERM",
  { skip: process.platform === "win32" },
  async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), "mf-shell-resistant-"));
    t.after(() => {
      for (const file of ["ready", "parent-pid"]) {
        const record = path.join(dir, file);
        if (!existsSync(record)) continue;
        try {
          process.kill(Number(readFileSync(record, "utf8")), "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      rmSync(dir, { recursive: true, force: true });
    });
    // The shell exits on TERM; the writer in its process group deliberately survives it.
    writeFileSync(
      path.join(dir, "writer.cjs"),
      `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync('ready',String(process.pid));let i=0;setInterval(()=>fs.writeFileSync('pulse',String(++i)),25);`,
    );
    writeFileSync(
      path.join(dir, "parent.cjs"),
      `require('node:fs').writeFileSync('parent-pid',String(process.pid));const {spawn}=require('node:child_process');spawn(process.execPath,['writer.cjs'],{stdio:'ignore'});setInterval(()=>{},1000);`,
    );
    const run = createSerialQueue();
    const outcome = run(() => runShell(`"${process.execPath}" parent.cjs`, dir, 700));
    const next = run(async () => {
      assert.equal(existsSync(path.join(dir, "ready")), true);
      const pulse = readFileSync(path.join(dir, "pulse"), "utf8");
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(readFileSync(path.join(dir, "pulse"), "utf8"), pulse);
    });
    await assert.rejects(outcome, (error) => safeError(error).reason === "timeout");
    await next;
  },
);
