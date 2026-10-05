import { createLogger } from "../src/shared/logging.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appProbeId,
  createProbeBook,
  putAppResult,
  type LocalApp,
} from "../src/entities/microfrontend/index.ts";
import { createConfirmationStore } from "../src/entities/federated-types/index.ts";
import {
  collectProducerEvidence,
  dependencyEvidence,
} from "../src/features/rebuild-types/evidence.ts";
import { rebuildTypes, type RebuildContext } from "../src/features/rebuild-types/workflow.ts";
import { installRemoteTypes } from "../src/features/refetch-types/remote.ts";
import { localApp } from "./support/app.ts";

test("a dependency named __proto__ retains its published ZIP hash", () => {
  const child = localApp("__proto__", path.resolve("child"), { generateTypes: true });
  const parent = localApp("parent", path.resolve("parent"), {
    remotes: [{ alias: "child", name: child.name, url: null }],
  });
  const evidence = dependencyEvidence(
    parent,
    [parent, child],
    createProbeBook(),
    new Map([[child.name, "hash"]]),
  );
  assert.deepEqual(evidence.dependencies, ["__proto__"]);
  assert.equal(Object.hasOwn(evidence.dependencyZipHashes, "__proto__"), true);
  assert.equal(evidence.dependencyZipHashes.__proto__, "hash");
  assert.equal(JSON.stringify(evidence.dependencyZipHashes), '{"__proto__":"hash"}');
});

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
  const logMessages: string[] = [];
  const log = createLogger({
    enabled: () => true,
    write: (_level, text) => logMessages.push(text),
  }).operation("rebuild");
  const context: RebuildContext = {
    log,
    apps: [parent, child],
    book,
    confirmations,
    published: new Map(),
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

  // The probe still has the old hash, but Last-Modified lets the child skip the next rebuild.
  const childProbe = book.apps.get(appProbeId("child"));
  assert.ok(childProbe);
  childProbe.zipMtime = Date.now() + 60_000;
  fs.writeFileSync(path.join(parent.folder, "app.ts"), "parent changed");
  events.length = 0;
  await rebuildTypes("parent", context, operations);
  assert.deepEqual(events, [
    "install:parent:child",
    "persist",
    "generate:parent",
    "persist",
    "done:parent",
  ]);
  assert.equal(childProbe.zipHash, "old", "the probe has not caught up with generation");
  assert.deepEqual(confirmations.generation("parent")?.builtDependencyHashes, {
    child: "new-child",
  });

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
  assert.ok(
    logMessages.some(
      (text) =>
        text.includes("action=skip") && text.includes("reason=sources-and-dependencies-fresh"),
    ),
  );
  assert.ok(
    logMessages.some((text) => text.includes("types.rebuild.plan") && text.includes("operation=1")),
  );
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
  const messages: string[] = [];
  const log = createLogger({
    enabled: (level) => ["info", "warn", "error"].includes(level),
    write: (_level, text) => messages.push(text),
  }).operation("rebuild");
  const context: RebuildContext = {
    log,
    apps: [app],
    book: createProbeBook(),
    confirmations,
    published: new Map(),
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
  assert.equal(context.published.get("app"), "published");
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
  assert.equal(messages.length, 1);
  assert.match(messages[0], /shell.failed operation=1 source=rebuild/);
  assert.match(messages[0], /kind=rebuild reason=shell-exit exitCode=3/);
  assert.equal(messages[0].includes("build 'app'"), false);
});

test("failed fetch commands expose the exit code at Info without logging the command or error message", async () => {
  const messages: string[] = [];
  const log = createLogger({
    enabled: (level) => ["info", "warn", "error"].includes(level),
    write: (_level, text) => messages.push(text),
  }).operation("fetch");
  await assert.rejects(
    () =>
      installRemoteTypes(
        localApp("shell", "/shell"),
        { alias: "widget", name: "widget", url: "https://example.com/manifest.json" },
        "https://example.com/manifest.json",
        "fetch SECRET {typesFolder}",
        {
          async manifestZipUrl() {
            return "https://example.com/types.zip";
          },
          async refetchInstalled(input) {
            assert.ok(input.runCommand);
            const code = await input.runCommand(input.command, input.consumerFolder, 1000);
            throw new Error(`refetch command exited ${code}: SECRET`);
          },
          async runShell() {
            return 9;
          },
        },
        log,
      ),
    /refetch command exited 9/,
  );
  assert.ok(messages.some((text) => /kind=fetch reason=shell-exit exitCode=9/.test(text)));
  assert.ok(messages.every((text) => text.includes("operation=1 source=fetch")));
  assert.equal(messages.join(" ").includes("SECRET"), false);
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
            published: new Map(),
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
