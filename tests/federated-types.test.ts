import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { filesFingerprint } from "../src/shared/fingerprint.ts";
import {
  createConfirmationStore,
  describeLink,
  readInstalledEvidence,
  sourceContains,
  sourceSnapshot,
} from "../src/entities/federated-types/index.ts";

test("confirmation lookups preserve storage format and return independent copies", () => {
  const link = {
    consumer: "shell",
    alias: "widget",
    remoteName: "widget",
    url: "https://example.com/mf-manifest.json",
  };
  const store = createConfirmationStore();
  const hashes = { dep: "old" };
  store.saveInstall(link, "files", "zip");
  store.saveGeneration("widget", "source", "zip", hashes);
  hashes.dep = "mutated";
  const snapshot = store.snapshot();
  const restored = createConfirmationStore(snapshot);
  assert.deepEqual(restored.snapshot(), snapshot);
  const install = restored.install(link);
  assert.ok(install);
  install.zipHash = "mutated";
  assert.equal(restored.install(link)?.zipHash, "zip");
  const generation = restored.generation("widget");
  assert.ok(generation);
  generation.builtDependencyHashes.dep = "mutated";
  snapshot.generations[0].builtDependencyHashes.dep = "mutated";
  assert.equal(restored.generationConfirmed("widget", "source", "zip", { dep: "old" }), true);
  assert.equal(restored.generationConfirmed("widget", "changed", "zip", { dep: "old" }), false);
  assert.equal(restored.generationConfirmed("widget", "source", "zip", { dep: "new" }), false);
  assert.equal(restored.install({ ...link, alias: "missing" }), null);
  assert.equal(restored.generation("missing"), null);
});

test("source snapshots respect inherited includes, excludes, output folders and symlinks", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-sources-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "base.json"),
    JSON.stringify({
      include: ["**/*.ts", "src/**/*.tsx"],
      exclude: ["excluded", "src/*.spec.ts", "src/direct.ts"],
      compilerOptions: { outDir: "emitted" },
    }),
  );
  fs.writeFileSync(path.join(root, "tsconfig.json"), '{ "extends": "./base", }');
  for (const name of [
    "src/nested/app.ts",
    "src/nested/view.tsx",
    "src/direct.ts",
    "src/test.spec.ts",
    "src/types.d.ts",
    "excluded/no.ts",
    "emitted/no.ts",
    "dist/no.ts",
    "@mf-types/no.ts",
    "node_modules/pkg/no.ts",
    ".git/no.ts",
  ]) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, name);
  }
  fs.symlinkSync(path.join(root, "src/nested"), path.join(root, "linked"), "dir");
  const result = sourceSnapshot(root, null, "@mf-types");
  assert.deepEqual(result.files.map((file) => file.name).sort(), [
    "src/nested/app.ts",
    "src/nested/view.tsx",
  ]);
  assert.equal(typeof result.savedAt, "number");
  assert.equal(new TextDecoder().decode(result.files[0].bytes), result.files[0].name);
  fs.rmSync(path.join(root, "src/nested/app.ts"));
  assert.deepEqual(
    sourceSnapshot(root, null, "@mf-types").files.map((file) => file.name),
    ["src/nested/view.tsx"],
  );
});

test("source membership does not read source bytes and wildcard scans prune skipped directories", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-membership-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "tsconfig.json"), '{"include":["**/*.ts"]}');
  const source = path.join(root, "app.ts");
  fs.writeFileSync(source, "source");
  for (const name of ["node_modules/pkg", "@mf-types/widget", "dist/compiled"]) {
    const folder = path.join(root, name);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "ignored.ts"), "ignored");
  }
  const read = t.mock.method(fs, "readFileSync");
  const list = t.mock.method(fs, "readdirSync");
  assert.equal(sourceContains(root, null, "@mf-types", source), true);
  assert.equal(
    sourceContains(root, null, "@mf-types", path.join(root, "dist/compiled/ignored.ts")),
    false,
  );
  assert.equal(
    read.mock.calls.some((call) => String(call.arguments[0]) === source),
    false,
  );
  assert.equal(
    list.mock.calls.some((call) => String(call.arguments[0]).includes("node_modules")),
    false,
  );
  assert.equal(
    list.mock.calls.some((call) => String(call.arguments[0]).includes("@mf-types")),
    false,
  );
  assert.equal(
    list.mock.calls.some((call) => String(call.arguments[0]).includes("dist")),
    false,
  );
});

test("link classification uses provided evidence, settle time and install confirmation", () => {
  const input = {
    consumeTypes: true,
    producer: { generateTypes: true, sourceSavedAt: 2000 },
    producerZipMtime: 1000,
    linkZipHash: "zip",
    linkZipReachable: true,
    linkUrl: "https://example.com/mf-manifest.json",
    generationConfirmed: false,
    installConfirmation: {
      zipHash: "zip",
      filesFingerprint: "files",
      url: "https://example.com/mf-manifest.json",
    },
    checkedAt: 2050,
    typesSettleMs: 100,
    installed: { folderExists: true, filesFingerprint: "files" },
  };
  assert.equal(describeLink(input), "ok");
  assert.equal(describeLink({ ...input, checkedAt: 2100 }), "stale-source");
  assert.equal(describeLink({ ...input, consumeTypes: false, checkedAt: 2100 }), "none");
  assert.equal(
    describeLink({ ...input, installed: { folderExists: false, filesFingerprint: null } }),
    "unfetched",
  );
  assert.equal(
    describeLink({ ...input, linkUrl: "https://changed.example/mf-manifest.json" }),
    "unfetched",
  );
  assert.equal(describeLink({ ...input, producerZipMtime: null }), "unknown");
  assert.equal(describeLink({ ...input, producerZipMtime: null, generationConfirmed: true }), "ok");
});

test("relative excludes follow TypeScript semantics inside the app", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-relative-exclude-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "config"));
  fs.mkdirSync(path.join(root, "shared"));
  const source = path.join(root, "shared", "app.ts");
  fs.writeFileSync(source, "export const value = 1;");
  const config = path.join(root, "config", "tsconfig.json");
  const include = ["../shared/**/*.ts"];
  fs.writeFileSync(config, JSON.stringify({ include }));
  const baseline = sourceSnapshot(root, "config/tsconfig.json", "@mf-types");
  assert.deepEqual(
    baseline.files.map((file) => file.name),
    ["shared/app.ts"],
  );
  const fingerprint = filesFingerprint(baseline.files);
  const confirmations = createConfirmationStore();
  confirmations.saveGeneration("app", fingerprint, "zip", {});
  for (const exclude of ["../shared", "..", "../"]) {
    fs.writeFileSync(config, JSON.stringify({ include, exclude: [exclude] }));
    const snapshot = sourceSnapshot(root, "config/tsconfig.json", "@mf-types");
    assert.deepEqual(snapshot.files, [], exclude);
    assert.equal(sourceContains(root, "config/tsconfig.json", "@mf-types", source), false);
    assert.equal(
      confirmations.generationConfirmed("app", filesFingerprint(snapshot.files), "zip", {}),
      false,
    );
  }
});

test("installed evidence distinguishes absent paths, files and an empty directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-installed-evidence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const absent = { folderExists: false, filesFingerprint: null };
  assert.deepEqual(readInstalledEvidence(null), absent);
  assert.deepEqual(readInstalledEvidence(path.join(root, "missing")), absent);
  const file = path.join(root, "types.txt");
  fs.writeFileSync(file, "not a directory");
  assert.deepEqual(readInstalledEvidence(file), absent);
  fs.unlinkSync(file);
  assert.deepEqual(readInstalledEvidence(root), {
    folderExists: true,
    filesFingerprint: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  });
  fs.writeFileSync(file, "types");
  assert.deepEqual(readInstalledEvidence(root), {
    folderExists: true,
    filesFingerprint: filesFingerprint([
      { name: "types.txt", bytes: new TextEncoder().encode("types") },
    ]),
  });
});

test("installed evidence reports an unreadable directory without a valid fingerprint", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-unreadable-types-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const read = t.mock.method(fs, "readdirSync", () => {
    throw new Error("EACCES");
  });
  assert.deepEqual(readInstalledEvidence(root), { folderExists: true, filesFingerprint: "" });
  read.mock.restore();
});

test("empty install URLs neither create nor overwrite confirmations", () => {
  const link = {
    consumer: "shell",
    alias: "widget",
    remoteName: "widget",
    url: "https://example.com/mf-manifest.json",
  };
  for (const url of [null, "", " \t\n "]) {
    const store = createConfirmationStore();
    store.saveInstall({ ...link, url }, "ignored-files", "ignored-zip");
    assert.equal(store.install(link), null);
    assert.deepEqual(store.snapshot().installs, []);
    store.saveInstall(link, "files", "zip");
    const saved = store.snapshot();
    store.saveInstall({ ...link, url }, "replacement-files", "replacement-zip");
    assert.deepEqual(store.snapshot(), saved);
  }
});

test("installed evidence only treats ENOENT as a missing directory", (t) => {
  for (const code of ["ENOENT", "EACCES", "EIO", "ENOTDIR", undefined]) {
    const error = Object.assign(new Error(code ?? "unexpected failure"), { code });
    const stat = t.mock.method(fs, "statSync", () => {
      throw error;
    });
    try {
      if (code === "ENOENT") {
        assert.deepEqual(readInstalledEvidence("/types"), {
          folderExists: false,
          filesFingerprint: null,
        });
      } else {
        assert.throws(
          () => readInstalledEvidence("/types"),
          (caught) => caught === error,
        );
      }
    } finally {
      stat.mock.restore();
    }
  }
});
