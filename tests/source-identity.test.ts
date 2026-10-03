import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { sourceIdentity, sourceSnapshot } from "../src/entities/federated-types/sources.ts";
import { filesFingerprint } from "../src/shared/fingerprint.ts";

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-src-identity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ include: ["src/**/*.ts"] }));
  const file = path.join(root, "src", "main.ts");
  fs.writeFileSync(file, "export const value = 1;\n");
  const time = Math.floor(Date.now() / 1000) - 10;
  fs.utimesSync(file, time, time);
  return { root, file, time, identity: () => sourceIdentity(root, "tsconfig.json", "@mf-types") };
}

test("unchanged metadata reuses fingerprint without reading source bytes", (t) => {
  const { file, time, identity } = fixture(t);
  const first = identity();
  fs.writeFileSync(file, "export const value = 2;\n");
  fs.utimesSync(file, time, time);
  const read = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]) === file) reads++;
    return read(...args);
  });
  const second = identity();
  assert.equal(second.fingerprint, first.fingerprint);
  assert.deepEqual(second.names, ["src/main.ts"]);
  assert.equal(reads, 0);
  second.names.length = 0;
  assert.deepEqual(identity().names, ["src/main.ts"]);
});

test("mtime invalidates the identity and advances savedAt", (t) => {
  const { file, time, identity } = fixture(t);
  const first = identity();
  fs.writeFileSync(file, "export const value = 2;\n");
  fs.utimesSync(file, time, time + 1);
  const second = identity();
  assert.notEqual(second.fingerprint, first.fingerprint);
  assert.equal(second.savedAt, (first.savedAt ?? 0) + 1000);
});

test("size invalidates the identity even when mtime stays", (t) => {
  const { file, time, identity } = fixture(t);
  const first = identity();
  fs.writeFileSync(file, "export const value = 100;\n");
  fs.utimesSync(file, time, time);
  assert.notEqual(identity().fingerprint, first.fingerprint);
});

test("adding, deleting and renaming files invalidate names and fingerprint", (t) => {
  const { root, file, identity } = fixture(t);
  const first = identity();
  const added = path.join(root, "src", "extra.ts");
  fs.writeFileSync(added, "export const extra = 1;\n");
  const second = identity();
  assert.deepEqual(second.names, ["src/extra.ts", "src/main.ts"]);
  assert.notEqual(second.fingerprint, first.fingerprint);
  fs.unlinkSync(added);
  assert.equal(identity().fingerprint, first.fingerprint);
  fs.renameSync(file, added);
  assert.deepEqual(identity().names, ["src/extra.ts"]);
  assert.notEqual(identity().fingerprint, first.fingerprint);
});

test("config includes and input paths select independent identities", (t) => {
  const { root, identity } = fixture(t);
  const first = identity();
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ include: [] }));
  assert.deepEqual(identity().names, []);
  fs.writeFileSync(path.join(root, "alternate.json"), JSON.stringify({ include: ["src/**/*.ts"] }));
  const alternate = sourceIdentity(root, "alternate.json", "@mf-types");
  assert.equal(alternate.fingerprint, first.fingerprint);
  assert.deepEqual(sourceIdentity(root, "alternate.json", "src").names, []);
  assert.equal(sourceIdentity(root, "alternate.json", "@mf-types").fingerprint, first.fingerprint);
  assert.equal(
    alternate.fingerprint,
    filesFingerprint(sourceSnapshot(root, "alternate.json", "@mf-types").files),
  );
});
