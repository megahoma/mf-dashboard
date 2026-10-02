import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolvePackageManager, startInvocation } from "../src/features/start-app/start.ts";

function withTemp(run: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-pm-"));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("explicit yarn ignores a pnpm lockfile", () => {
  withTemp((root) => {
    fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "");
    assert.equal(resolvePackageManager(root, "yarn"), "yarn");
  });
});

test("explicit bun ignores package-lock.json", () => {
  withTemp((root) => {
    fs.writeFileSync(path.join(root, "package-lock.json"), "{}");
    assert.equal(resolvePackageManager(root, "bun"), "bun");
  });
});

test("packageManager field yarn@4.1.0 selects yarn", () => {
  withTemp((root) => {
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ packageManager: "yarn@4.1.0" }),
    );
    fs.writeFileSync(path.join(root, "package-lock.json"), "{}");
    assert.equal(resolvePackageManager(root, "auto"), "yarn");
  });
});

test("packageManager field bun@1.1.0 selects bun", () => {
  withTemp((root) => {
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ packageManager: "bun@1.1.0" }),
    );
    assert.equal(resolvePackageManager(root, "auto"), "bun");
  });
});

test("an unknown packageManager name falls through to the lockfile", () => {
  withTemp((root) => {
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ packageManager: "deno@2.0.0" }),
    );
    fs.writeFileSync(path.join(root, "package-lock.json"), "{}");
    assert.equal(resolvePackageManager(root, "auto"), "npm");
  });
});

test("lockfile order is pnpm, yarn, bun, npm", () => {
  withTemp((root) => {
    fs.writeFileSync(path.join(root, "package-lock.json"), "{}");
    fs.writeFileSync(path.join(root, "bun.lockb"), "");
    assert.equal(resolvePackageManager(root, "auto"), "bun");
    fs.writeFileSync(path.join(root, "yarn.lock"), "");
    assert.equal(resolvePackageManager(root, "auto"), "yarn");
    fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "");
    assert.equal(resolvePackageManager(root, "auto"), "pnpm");
  });
});

test("bun.lock and bun.lockb both mean bun", () => {
  withTemp((lockb) => {
    fs.writeFileSync(path.join(lockb, "bun.lockb"), "");
    assert.equal(resolvePackageManager(lockb, "auto"), "bun");
  });
  withTemp((lock) => {
    fs.writeFileSync(path.join(lock, "bun.lock"), "");
    assert.equal(resolvePackageManager(lock, "auto"), "bun");
  });
});

test("a folder with no marker stays on npm", () => {
  withTemp((root) => {
    assert.equal(resolvePackageManager(root, "auto"), "npm");
  });
});

test("startInvocation runs yarn and bun with run", () => {
  assert.deepEqual(
    startInvocation({
      packageManager: "yarn",
      scriptKey: "dev",
      scriptBody: "vite",
      cwd: "/widget-1",
      portOpen: false,
    }),
    { command: "yarn", args: ["run", "dev"], cwd: "/widget-1" },
  );
  assert.deepEqual(
    startInvocation({
      packageManager: "bun",
      scriptKey: "dev",
      scriptBody: "vite",
      cwd: "/widget-1",
      portOpen: false,
    }),
    { command: "bun", args: ["run", "dev"], cwd: "/widget-1" },
  );
});

test("startInvocation stays idle when the port is open, the script is missing, or the key is unsafe", () => {
  const ready = {
    packageManager: "npm" as const,
    scriptKey: "dev",
    scriptBody: "vite",
    cwd: "/widget-1",
    portOpen: false,
  };
  assert.equal(startInvocation({ ...ready, portOpen: true }), null);
  assert.equal(startInvocation({ ...ready, scriptBody: null }), null);
  assert.equal(startInvocation({ ...ready, scriptKey: "dev;rm" }), null);
});
