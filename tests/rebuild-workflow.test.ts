import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createProbeBook,
  putAppResult,
  type LocalApp,
} from "../src/entities/microfrontend/index.ts";
import { createConfirmationStore } from "../src/entities/federated-types/index.ts";
import { collectProducerEvidence } from "../src/features/rebuild-types/evidence.ts";
import { rebuildTypes, type RebuildContext } from "../src/features/rebuild-types/workflow.ts";
import { installRemoteTypes } from "../src/features/refetch-types/remote.ts";
import { localApp } from "./support/app.ts";

test("rebuild installs dependencies before generation and saves the newly built dependency hash", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-rebuild-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = localApp("child", path.join(root, "child"));
  const parent = localApp("parent", path.join(root, "parent"), {
    consumeTypes: true,
    remotes: [
      { alias: "child", name: "child", url: "https://configured.example/mf-manifest.json" },
    ],
  });
  for (const app of [parent, child]) {
    fs.mkdirSync(app.folder);
    fs.writeFileSync(path.join(app.folder, "app.ts"), app.name);
  }
  const events: string[] = [];
  const confirmations = createConfirmationStore();
  const book = createProbeBook();
  putAppResult(book, "child", {
    portOpen: true,
    manifestReachable: true,
    buildVersion: null,
    zipUrl: "https://example.com/types.zip",
    zipMtime: null,
    zipHash: "old",
    exposes: [],
    shared: [],
  });
  const context: RebuildContext = {
    apps: [parent, child],
    book,
    confirmations,
    settings: { "mf-dashboard.scripts.start": "dev", rebuildCommand: "" },
    refetchCommand: () => "",
    persist: () => {
      events.push("persist");
    },
    rebuilt: (name) => {
      events.push(`done:${name}`);
    },
  };
  const operations: NonNullable<Parameters<typeof rebuildTypes>[2]> = {
    collectProducerEvidence,
    async installRemoteTypes(app, remote, url) {
      events.push(`install:${app.name}:${remote.name}`);
      assert.equal(url, "http://127.0.0.1:4100/mf-manifest.json");
      return { filesFingerprint: "installed", zipHash: "new-child" };
    },
    async generateFederatedTypes(input) {
      const name = path.basename(input.appDir);
      events.push(`generate:${name}`);
      return { zipPath: "unused", zipUrl: "unused", zipHash: `new-${name}` };
    },
    async hashManifestZip() {
      throw new Error("no custom command");
    },
    async runShell() {
      throw new Error("no custom command");
    },
  };
  await rebuildTypes("parent", context, operations);
  assert.deepEqual(events, [
    "generate:child",
    "persist",
    "done:child",
    "install:parent:child",
    "persist",
    "generate:parent",
    "persist",
    "done:parent",
  ]);
  assert.deepEqual(confirmations.generation("parent")?.builtDependencyHashes, {
    child: "new-child",
  });
  assert.equal(
    confirmations.install({ consumer: "parent", alias: "child", remoteName: "child" })?.url,
    parent.remotes[0].url,
  );

  for (const app of [parent, child]) {
    putAppResult(book, app.name, {
      portOpen: true,
      manifestReachable: true,
      buildVersion: null,
      zipUrl: "https://example.com/types.zip",
      zipMtime: null,
      zipHash: `new-${app.name}`,
      exposes: [],
      shared: [],
    });
  }
  events.length = 0;
  await rebuildTypes("parent", context, operations);
  assert.equal(events.length, 0, "unchanged confirmed generations should be skipped");
  book.apps.clear();

  events.length = 0;
  await assert.rejects(
    () =>
      rebuildTypes("parent", context, {
        ...operations,
        async installRemoteTypes() {
          events.push("failed-install");
          throw new Error("installation failed");
        },
      }),
    /installation failed/,
  );
  assert.deepEqual(events, ["generate:child", "persist", "done:child", "failed-install"]);

  child.remotes = [{ alias: "parent", name: "parent", url: null }];
  events.length = 0;
  await assert.rejects(() => rebuildTypes("parent", context, operations), /cycle:/);
  assert.deepEqual(events, []);
});

test("custom rebuild checks the published archive and never confirms a failed command", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-rebuild-command-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = localApp("app", root);
  const confirmations = createConfirmationStore();
  const context: RebuildContext = {
    apps: [app],
    book: createProbeBook(),
    confirmations,
    settings: {
      "mf-dashboard.scripts.start": "dev",
      "mf-dashboard.apps": { app: { manifestPath: "custom.json" } },
      rebuildCommand: "build {name}",
    },
    refetchCommand: () => "",
    persist() {},
    rebuilt() {},
  };
  let checked = 0;
  const operations: NonNullable<Parameters<typeof rebuildTypes>[2]> = {
    collectProducerEvidence,
    async installRemoteTypes() {
      throw new Error("consumption disabled");
    },
    async generateFederatedTypes() {
      throw new Error("custom command selected");
    },
    async runShell(command, cwd, timeout) {
      assert.equal(command, "build 'app'");
      assert.equal(cwd, root);
      assert.equal(timeout, 300000);
      return 0;
    },
    async hashManifestZip(input) {
      checked++;
      assert.equal(input.manifestUrl, "http://127.0.0.1:4100/custom.json");
      return { zipUrl: "unused", zipHash: "published" };
    },
  };
  await rebuildTypes("app", context, operations);
  assert.equal(confirmations.generation("app")?.zipHash, "published");
  assert.equal(checked, 1);
  await assert.rejects(
    () =>
      rebuildTypes("app", context, {
        ...operations,
        async runShell() {
          return 3;
        },
      }),
    /rebuild command exited 3/,
  );
  assert.equal(checked, 1);
  assert.equal(confirmations.generation("app")?.zipHash, "published");
});

test("remote installation shares safe template parameters and reports manifest failures", async () => {
  const consumer: LocalApp = localApp("shell", "/shell");
  const remote = { alias: "widget", name: "producer", url: "https://example.com/mf-manifest.json" };
  let installs = 0;
  const operations: NonNullable<Parameters<typeof installRemoteTypes>[4]> = {
    async manifestZipUrl(input) {
      assert.equal(input.manifestUrl, remote.url);
      return "https://example.com/types.zip";
    },
    async refetchInstalled(input) {
      installs++;
      assert.equal(input.command, "fetch '/shell/@mf-types/widget'");
      assert.equal(input.url, "https://example.com/types.zip");
      assert.equal(input.remoteAlias, "widget");
      return { filesFingerprint: "files", zipHash: "zip" };
    },
    async runShell() {
      return 0;
    },
  };
  assert.deepEqual(
    await installRemoteTypes(consumer, remote, remote.url, "fetch {typesFolder}", operations),
    { filesFingerprint: "files", zipHash: "zip" },
  );
  await assert.rejects(
    () =>
      installRemoteTypes(consumer, remote, remote.url, "", {
        ...operations,
        async manifestZipUrl() {
          throw new Error("network");
        },
      }),
    /unreachable dependency: producer/,
  );
  await assert.rejects(
    () =>
      installRemoteTypes(consumer, { ...remote, alias: "../escape" }, remote.url, "", operations),
    /unsafe remote alias/,
  );
  assert.equal(installs, 1);
});

test("a dependency without a URL or producer port fails before installation or generation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-unreachable-dependency-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = localApp("shell", root, {
    consumeTypes: true,
    remotes: [{ alias: "widget", name: "widget", url: null }],
  });
  const producer = localApp("widget", root, { port: null, generateTypes: false });
  const unexpected = t.mock.fn(() => {
    throw new Error("unexpected side effect");
  });
  const confirmations = createConfirmationStore();
  for (const apps of [[app], [app, producer]]) {
    await assert.rejects(
      () =>
        rebuildTypes(
          "shell",
          {
            apps,
            book: createProbeBook(),
            confirmations,
            settings: { "mf-dashboard.scripts.start": "dev", rebuildCommand: "" },
            refetchCommand: unexpected,
            persist: unexpected,
            rebuilt: unexpected,
          },
          {
            collectProducerEvidence,
            installRemoteTypes: unexpected,
            generateFederatedTypes: unexpected,
            hashManifestZip: unexpected,
            runShell: unexpected,
          },
        ),
      /^Error: unreachable dependency: widget$/,
    );
    assert.equal(unexpected.mock.callCount(), 0);
    assert.deepEqual(confirmations.snapshot(), { installs: [], generations: [] });
  }
});
