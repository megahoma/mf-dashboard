import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { treeFingerprint } from "../src/entities/federated-types/tree-fingerprint.ts";
import { readTree } from "../src/entities/federated-types/install.ts";
import { filesFingerprint } from "../src/shared/fingerprint.ts";

function typesDir(t: test.TestContext): { root: string; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-tree-fingerprint-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "index.d.ts");
  fs.writeFileSync(file, "export declare const value = 1;\n");
  const seconds = Math.floor(fs.statSync(file).mtimeMs / 1000);
  fs.utimesSync(file, seconds, seconds);
  return { root, file };
}

test("unchanged file stamps skip byte reads, including directory mtime changes", (t) => {
  const { root, file } = typesDir(t);
  const first = treeFingerprint(root);
  assert.equal(first, filesFingerprint(readTree(root)));
  const stat = fs.statSync(file);
  fs.writeFileSync(file, "export declare const value = 2;\n");
  fs.utimesSync(file, stat.atime, stat.mtime);
  fs.utimesSync(root, stat.atime, new Date(stat.mtimeMs + 5000));
  const read = t.mock.method(fs, "readFileSync");
  assert.equal(treeFingerprint(root), first);
  assert.equal(read.mock.callCount(), 0);
});

test("size, mtime, added and removed nested files invalidate the fingerprint", (t) => {
  const { root, file } = typesDir(t);
  let previous = treeFingerprint(root);
  const changed = () => {
    const next = treeFingerprint(root);
    assert.notEqual(next, previous);
    assert.equal(next, filesFingerprint(readTree(root)));
    previous = next;
  };
  const stat = fs.statSync(file);
  fs.writeFileSync(file, "export declare const value = 2;\n");
  fs.utimesSync(file, stat.atime, new Date(stat.mtimeMs + 1000));
  changed();
  fs.appendFileSync(file, "// changed size\n");
  fs.utimesSync(file, stat.atime, new Date(stat.mtimeMs + 1000));
  changed();
  fs.mkdirSync(path.join(root, "nested"));
  const nested = path.join(root, "nested", "extra.d.ts");
  fs.writeFileSync(nested, "export declare const extra: string;\n");
  changed();
  fs.unlinkSync(nested);
  changed();
});

test("entry symlinks are rejected after a cache hit was primed", (t) => {
  const { root, file } = typesDir(t);
  treeFingerprint(root);
  fs.symlinkSync(file, path.join(root, "link.d.ts"));
  assert.throws(() => treeFingerprint(root), /unzip: symlink link\.d\.ts/);
});

test("a root replaced with a symlink is rejected even when file stamps match", (t) => {
  const { root } = typesDir(t);
  treeFingerprint(root);
  const moved = `${root}-moved`;
  t.after(() => fs.rmSync(moved, { recursive: true, force: true }));
  fs.renameSync(root, moved);
  fs.symlinkSync(moved, root, "dir");
  assert.throws(() => treeFingerprint(root), /unzip: symlink types directory/);
});

test("missing and empty trees keep the readTree empty fingerprint", (t) => {
  const { root, file } = typesDir(t);
  assert.equal(treeFingerprint(path.join(root, "missing")), filesFingerprint([]));
  fs.unlinkSync(file);
  assert.equal(treeFingerprint(root), filesFingerprint([]));
});
