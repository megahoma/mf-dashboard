import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, type TestContext } from "node:test";
import {
  createArchiveComparisonBatch,
  createConfirmationStore,
  disposeEvidenceWorker,
  readInstalledEvidenceAsync,
  sourceContainsAsync,
  sourceIdentity,
  sourceIdentityAsync,
  type InstalledEvidence,
} from "../src/entities/federated-types/index.ts";
import {
  indexComparisonArchive,
  matchesArchiveFiles,
} from "../src/entities/federated-types/lib/comparison-archive.ts";
import { readTree } from "../src/entities/federated-types/lib/types-tree.ts";
import {
  createProbeBook,
  linkProbeId,
  putAppResult,
  putLinkResult,
  readAppFolder,
} from "../src/entities/microfrontend/index.ts";
import { verifyTypeInstalls } from "../src/features/observe-types/lib/verify.ts";
import type { InstallCheck } from "../src/features/observe-types/models/verify.ts";
import {
  collectProducerEvidenceAsync,
  createPublishedZipComparison,
} from "../src/features/rebuild-types/lib/evidence.ts";
import { diagnosticFields } from "../src/shared/models/diagnostic-error.ts";
import { createLogger } from "../src/shared/lib/logging.ts";
import type { LogContext } from "../src/shared/models/logging.ts";
import { localApp } from "./support/app.ts";
import { zipFixture } from "./support/zip.ts";

after(disposeEvidenceWorker);

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mf-evidence-performance-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name: string, text: string) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  return { root, write };
}

function archiveFixture(t: TestContext) {
  const f = fixture(t);
  const archive = (
    records: Parameters<typeof zipFixture>[0] = [
      { file: "index.d.ts", text: "export type Value = 1;", deflate: true },
    ],
  ) => zipFixture(records);
  const bytes = archive();
  const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
  let downloads = 0;
  const input = {
    appDir: f.root,
    destination: path.join(f.root, "one"),
    url: "https://example.test/types.zip",
    expectedZipHash: hash(bytes),
    fetchImpl: async () => {
      downloads++;
      return new Response(bytes);
    },
  };
  f.write("one/index.d.ts", "export type Value = 1;");
  f.write("two/index.d.ts", "export type Value = 2;");
  return {
    ...f,
    input,
    bytes,
    hash,
    archive,
    downloads: () => downloads,
  };
}

test("overlapping include roots traverse each directory once and retain explicit-file semantics", (t) => {
  const f = fixture(t);
  f.write(
    "tsconfig.json",
    JSON.stringify({
      include: ["src/**/*.ts", "src/nested/*.ts", "src/**/a.ts"],
      exclude: ["src/excluded"],
      files: ["src/excluded/explicit.ts"],
    }),
  );
  f.write("src/a.ts", "export const a = 1;");
  f.write("src/nested/a.ts", "export const a = 2;");
  f.write("src/excluded/explicit.ts", "export const explicit = 3;");
  f.write("unselected/deep/ignored.ts", "ignored");
  const read = fs.readdirSync;
  const counts = new Map<string, number>();
  t.mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
    const directory = String(args[0]);
    if (directory.startsWith(f.root)) counts.set(directory, (counts.get(directory) ?? 0) + 1);
    return read(...args);
  });
  assert.deepEqual(sourceIdentity(f.root, null, "@mf-types").names, [
    "src/a.ts",
    "src/excluded/explicit.ts",
    "src/nested/a.ts",
  ]);
  assert.equal(counts.get(path.join(f.root, "src")), 1);
  assert.equal(counts.get(path.join(f.root, "src/nested")), 1);
  assert.equal(counts.has(path.join(f.root, "unselected")), false);
});

test("worker source scans observe external membership and inherited config edits without host reads", async (t) => {
  const f = fixture(t);
  f.write("base.json", JSON.stringify({ include: ["src/**/*.ts"] }));
  f.write("tsconfig.json", JSON.stringify({ extends: "./base.json" }));
  const firstFile = f.write("src/a.ts", "export const a = 1;");
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    assert.equal(
      String(args[0]).startsWith(f.root),
      false,
      "source scan must run outside extension host",
    );
    return read(...args);
  });
  const scan = () => sourceIdentityAsync(f.root, null, "@mf-types");
  const first = await scan();
  const added = f.write("src/b.ts", "export const b = 2;");
  assert.deepEqual((await scan()).names, ["src/a.ts", "src/b.ts"]);
  assert.equal(await sourceContainsAsync(f.root, null, "@mf-types", added), true);
  fs.unlinkSync(firstFile);
  assert.deepEqual((await scan()).names, ["src/b.ts"]);
  f.write("base.json", JSON.stringify({ include: [] }));
  assert.deepEqual((await scan()).names, []);
  f.write("base.json", "{ invalid");
  await assert.rejects(scan, /Invalid tsconfig/);
  assert.notEqual(
    (await sourceIdentityAsync(f.root, "missing.json", "@mf-types")).fingerprint,
    first.fingerprint,
  );
});

test("installed worker evidence detects preserved-mtime external edits and refuses symlinks", async (t) => {
  const f = fixture(t);
  const file = f.write("types/index.d.ts", "type Value = 1;");
  const time = Math.floor(Date.now() / 1000) - 20;
  fs.utimesSync(file, time, time);
  const first = await readInstalledEvidenceAsync(path.dirname(file));
  fs.writeFileSync(file, "type Value = 2;");
  fs.utimesSync(file, time, time);
  assert.notEqual(
    (await readInstalledEvidenceAsync(path.dirname(file))).filesFingerprint,
    first.filesFingerprint,
  );
  fs.symlinkSync(file, path.join(path.dirname(file), "linked.d.ts"));
  assert.equal((await readInstalledEvidenceAsync(path.dirname(file))).filesFingerprint, "");
});

test("one batch decodes each URL/hash once and compares every destination independently", async (t) => {
  const f = archiveFixture(t);
  const tasks: string[] = [];
  const log = createLogger({
    enabled: () => true,
    write: (_level, message) => tasks.push(message),
  });
  const compare = createArchiveComparisonBatch(log.operation("manual"));
  const decodes = () =>
    tasks.filter(
      (message) =>
        message.startsWith("evidence.task.finished") && message.includes("task=archive-comparison"),
    ).length;
  let timerRan = false;
  const timer = setTimeout(() => {
    timerRan = true;
  }, 0);
  t.after(() => clearTimeout(timer));
  const first = await compare(f.input);
  assert.equal(timerRan, true, "archive extraction must yield the extension host");
  assert.equal(first.matches, true);
  assert.equal(
    (await compare({ ...f.input, destination: path.join(f.root, "two") })).matches,
    false,
  );
  f.write("one/index.d.ts", "export type Value = 3;");
  assert.equal((await compare(f.input)).matches, false);
  assert.equal(f.downloads(), 1);
  assert.equal(decodes(), 1);
  await compare({ ...f.input, url: "https://example.test/other.zip" });
  assert.equal(f.downloads(), 2, "URL changes cannot reuse unrelated archive evidence");
  assert.equal(decodes(), 2);
});

test("archive batch retains failures and a new batch permits retry", async (t) => {
  const f = archiveFixture(t);
  const compare = createArchiveComparisonBatch();
  await assert.rejects(compare({ ...f.input, expectedZipHash: "old-hash" }), /archive changed/);
  for (const file of ["../escape.d.ts", "/absolute.d.ts", "C:\\escape.d.ts"]) {
    const bytes = f.archive([{ file, text: "unsafe" }]);
    await assert.rejects(
      compare({
        ...f.input,
        expectedZipHash: f.hash(bytes),
        fetchImpl: async () => new Response(bytes),
      }),
      (error: unknown) => {
        assert.equal(diagnosticFields(error).reason, "archive-invalid");
        return true;
      },
    );
  }
  const symlinkBytes = f.archive([
    { file: "linked.d.ts", text: "unsafe", attr: (0o120777 << 16) >>> 0 },
  ]);
  await assert.rejects(
    compare({
      ...f.input,
      expectedZipHash: f.hash(symlinkBytes),
      fetchImpl: async () => new Response(symlinkBytes),
    }),
    /symlink/,
  );
  let fail = true;
  const retryInput = {
    ...f.input,
    fetchImpl: async () =>
      fail ? new Response("offline", { status: 503 }) : new Response(f.bytes),
  };
  await assert.rejects(compare(retryInput), /status 503/);
  fail = false;
  await assert.rejects(
    compare(retryInput),
    /status 503/,
    "a failed batch does not retry per consumer",
  );
  assert.equal(
    (await createArchiveComparisonBatch()(retryInput)).matches,
    true,
    "the next refresh retries failed archive evidence",
  );
});

test("archive comparison rejects corrupt entries and oversized expansion", async (t) => {
  const f = archiveFixture(t);
  const compare = createArchiveComparisonBatch();
  const verify = (bytes: Buffer<ArrayBuffer>) =>
    compare({
      ...f.input,
      expectedZipHash: f.hash(bytes),
      fetchImpl: async () => new Response(bytes),
    });
  await assert.rejects(
    verify(f.archive([{ file: "index.d.ts", text: "abc", crc: 1 }])),
    /invalid CRC/,
  );
  const withDescriptor = f.archive([
    { file: "index.d.ts", text: "export type Value = 1;", deflate: true, descriptor: true },
  ]);
  assert.equal((await verify(withDescriptor)).matches, true);
  for (const deflate of [false, true]) {
    const invalid = f.archive([{ file: "index.d.ts", text: "export type Value = 1;", deflate }]);
    invalid.writeUInt32LE(1, 14);
    await assert.rejects(verify(invalid), /inconsistent ZIP CRC/);
  }
  await assert.rejects(
    verify(
      f.archive([{ file: "index.d.ts", text: "abc", deflate: true, size: 129 * 1024 * 1024 }]),
    ),
    /expanded size limit/,
  );
  await assert.rejects(
    verify(
      f.archive([
        { file: "index.d.ts", text: "one" },
        { file: "./index.d.ts", text: "two" },
      ]),
    ),
    /duplicate ZIP entry/,
  );
  await assert.rejects(
    verify(
      f.archive([
        { file: "types", text: "file" },
        { file: "types-extra/index.d.ts", text: "other" },
        { file: "types/index.d.ts", text: "conflict" },
      ]),
    ),
    /file conflicts with a directory/,
  );
  await assert.rejects(
    verify(
      f.archive([
        { file: "first.d.ts", text: "first", deflate: true },
        { file: "alias.d.ts", text: "first", deflate: true, localOffset: 0 },
      ]),
    ),
    /overlapping ZIP records/,
  );
});

test("archive comparison bounds the total number of ZIP extra fields", async (t) => {
  const f = archiveFixture(t);
  const compare = createArchiveComparisonBatch();
  const verify = (bytes: Buffer<ArrayBuffer>) =>
    compare({
      ...f.input,
      expectedZipHash: f.hash(bytes),
      fetchImpl: async () => new Response(bytes),
    });
  const fields = (count: number) => {
    const extra = Buffer.alloc(count * 4);
    for (let offset = 0; offset < extra.length; offset += 4) extra.writeUInt16LE(0xffff, offset);
    return extra;
  };
  const record = { file: "index.d.ts", text: "export type Value = 1;", deflate: true };
  assert.equal((await verify(f.archive([{ ...record, extraFields: fields(2) }]))).matches, true);

  const extraFields = fields(16_000);
  const directories = Array.from({ length: 13 }, (_, i) => ({
    file: `folder-${i}/`,
    text: "",
    extraFields,
  }));
  await assert.rejects(
    verify(f.archive([record, ...directories])),
    /ZIP exceeds extra field limit/,
  );
});

test("archive comparison checks the same central filename as installation", async (t) => {
  const f = archiveFixture(t);
  const compare = createArchiveComparisonBatch();
  const verify = (file: string) => {
    const bytes = f.archive([{ file, text: "export type Value = 1;", unicodePath: "index.d.ts" }]);
    return compare({
      ...f.input,
      expectedZipHash: f.hash(bytes),
      fetchImpl: async () => new Response(bytes),
    });
  };
  assert.equal((await verify("index.d.ts")).matches, true);
  assert.equal((await verify("different.d.ts")).matches, false);
  await assert.rejects(verify("../outside.d.ts"), /traversal/);
});

test("archive comparison uses the destination's aliases for differently cased paths", async (t) => {
  const f = archiveFixture(t);
  const destination = path.join(f.root, "mixed");
  const first = f.write("mixed/Types/a.d.ts", "type A = 1;");
  const second = f.write("mixed/Types/b.d.ts", "type B = 2;");
  const caseInsensitive = fs.existsSync(path.join(destination, "types", "b.d.ts"));
  const compare = createArchiveComparisonBatch();
  const verify = (records: Parameters<typeof zipFixture>[0]) => {
    const bytes = f.archive(records);
    return compare({
      ...f.input,
      destination,
      expectedZipHash: f.hash(bytes),
      fetchImpl: async () => new Response(bytes),
    });
  };
  const records = [
    { file: "Types/a.d.ts", text: "type A = 1;" },
    { file: "types/b.d.ts", text: "type B = 2;" },
  ];

  const result = await verify(records);
  assert.equal(result.matches, caseInsensitive);
  assert.equal(
    result.filesFingerprint,
    (await readInstalledEvidenceAsync(destination)).filesFingerprint,
  );
  fs.writeFileSync(second, "type B = 3;");
  assert.equal((await verify(records)).matches, false);
  fs.writeFileSync(second, records[1].text);
  assert.equal(
    (await verify([records[0], { file: "types/A.d.ts", text: records[0].text }])).matches,
    false,
  );
  if (!caseInsensitive) {
    fs.unlinkSync(second);
    f.write("mixed/types/b.d.ts", records[1].text);
    assert.equal((await verify(records)).matches, true);
  }
  fs.unlinkSync(first);
  assert.equal((await verify(records)).matches, false);
});

test("archive comparison rejects directory entries that alias a file on the destination volume", async (t) => {
  const f = archiveFixture(t);
  const compare = createArchiveComparisonBatch();
  const expectCollision = fs.existsSync(path.join(f.input.destination, "INDEX.d.ts"));
  for (const [directory, matches] of [
    ["empty/folder/", true],
    ["INDEX.d.ts/", !expectCollision],
    ["INDEX.d.ts/nested/", !expectCollision],
  ] as const) {
    const bytes = f.archive([
      { file: "index.d.ts", text: "export type Value = 1;" },
      { file: directory, text: "" },
    ]);
    const result = await compare({
      ...f.input,
      expectedZipHash: f.hash(bytes),
      fetchImpl: async () => new Response(bytes),
    });
    assert.equal(result.matches, matches, directory);
  }
});

test("archive comparison follows Unicode aliases defined by the destination volume", async (t) => {
  const f = archiveFixture(t);
  const compare = createArchiveComparisonBatch();
  const spellings = [
    ["Straße", "STRAẞE"],
    ["CAFÉ", "cafe\u0301"],
    ["shortK", "shortk"],
  ];
  for (const [index, [actual, alias]] of spellings.entries()) {
    const folder = `unicode-${index}`;
    const destination = path.join(f.root, folder);
    f.write(`${folder}/${actual}/a.d.ts`, "type A = 1;");
    f.write(`${folder}/${actual}/b.d.ts`, "type B = 2;");
    const bytes = f.archive([
      { file: `${actual}/a.d.ts`, text: "type A = 1;" },
      { file: `${alias}/b.d.ts`, text: "type B = 2;" },
    ]);
    const result = await compare({
      ...f.input,
      destination,
      expectedZipHash: f.hash(bytes),
      fetchImpl: async () => new Response(bytes),
    });
    assert.equal(result.matches, fs.existsSync(path.join(destination, alias, "b.d.ts")), alias);
  }
});

test("archive comparison resolves aliases on volumes that preserve lookup spellings", async (t) => {
  const f = fixture(t);
  f.write("Types/Nested/a.d.ts", "type A = 1;");
  f.write("Types/Nested/b.d.ts", "type B = 2;");
  const archive = await indexComparisonArchive(
    zipFixture([
      { file: "types/Nested/a.d.ts", text: "type A = 1;" },
      { file: "types/nested/b.d.ts", text: "type B = 2;" },
    ]),
  );
  const caseInsensitive = fs.existsSync(path.join(f.root, "types", "nested", "b.d.ts"));
  const root = fs.realpathSync.native(f.root);
  t.mock.method(fs.realpathSync, "native", (file: string) => {
    fs.statSync(file);
    return file;
  });
  assert.equal(matchesArchiveFiles(root, readTree(root), archive), caseInsensitive);
});

test("archive comparison requires matching file names and bytes even with NUL delimiters in files", async (t) => {
  const f = archiveFixture(t);
  const destination = path.join(f.root, "framing");
  f.write("framing/a.d.ts", "one");
  f.write("framing/b.d.ts", "two\0c.d.ts\0three");
  const bytes = f.archive([
    { file: "a.d.ts", text: "one\0b.d.ts\0two" },
    { file: "c.d.ts", text: "three" },
  ]);
  const result = await createArchiveComparisonBatch()({
    ...f.input,
    destination,
    expectedZipHash: f.hash(bytes),
    fetchImpl: async () => new Response(bytes),
  });
  assert.equal(result.matches, false);
});

test("source freshness recognizes repacked generation archives and checks their dependency contents", async (t) => {
  const f = archiveFixture(t);
  const book = createProbeBook();
  const store = createConfirmationStore();
  const dependency = localApp("shared", path.join(f.root, "shared"));
  const producer = localApp("widget", path.join(f.root, "widget"), {
    remotes: [{ name: "shared", alias: "shared", url: "http://127.0.0.1/mf-manifest.json" }],
  });
  const apps = [dependency, producer];
  const archives = new Map<string, ReturnType<typeof zipFixture>>();
  const fetch = t.mock.method(globalThis, "fetch", async (url: string) => {
    return new Response(archives.get(url));
  });
  const publish = (name: string, text: string) => {
    const zipUrl = `http://127.0.0.1/${name}/types.zip`;
    const bytes = f.archive([{ file: "index.d.ts", text }]);
    archives.set(zipUrl, bytes);
    putAppResult(book, name, {
      portOpen: true,
      manifestReachable: true,
      buildVersion: null,
      zipUrl,
      zipHash: f.hash(bytes),
      zipMtime: null,
      exposes: [],
      shared: [],
    });
  };
  for (const app of apps) {
    f.write(`${app.name}/index.ts`, "export type Value = 1;");
    const zipPath = path.join(app.folder, "dist.zip");
    fs.writeFileSync(zipPath, f.bytes);
    const { fingerprint } = sourceIdentity(app.folder, app.tsconfig, app.typesFolder);
    const dependencies: Record<string, string> =
      app === producer ? { shared: f.hash(f.bytes) } : {};
    store.saveGeneration(app.name, fingerprint, f.hash(f.bytes), dependencies, {
      zipPath,
      inputsFingerprint: "inputs",
    });
    publish(app.name, "export type Value = 1;");
  }
  const compareZip = createPublishedZipComparison();
  const observe = (allowDownload = true) =>
    collectProducerEvidenceAsync(producer, apps, book, store, compareZip, undefined, allowDownload);
  const timeouts = t.mock.method(AbortSignal, "timeout");
  assert.notEqual(f.hash(f.bytes), f.hash(archives.get("http://127.0.0.1/widget/types.zip")!));
  assert.equal((await observe(false)).sourceFreshness, "unknown");
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal((await observe()).sourceFreshness, "fresh");
  assert.equal((await observe(false)).sourceFreshness, "fresh");
  assert.equal(fetch.mock.callCount(), 2);
  assert.deepEqual(
    timeouts.mock.calls.map(({ arguments: [ms] }) => ms),
    [10_000, 10_000],
  );
  publish("shared", "export type Value = 2;");
  assert.equal((await observe(false)).sourceFreshness, "unknown");
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal((await observe()).sourceFreshness, "unknown");
  publish("shared", "export type Value = 1;");
  f.write("widget/index.ts", "export type Value = 3;");
  assert.equal((await observe()).sourceFreshness, "unknown");
});

test("verification logs archive decoding and internal installed reads in the same operation", async (t) => {
  const f = archiveFixture(t);
  f.write("@mf-types/widget/index.d.ts", "export type Value = 1;");
  const app = localApp("shell", f.root, { consumeTypes: true });
  const link = {
    consumer: app.name,
    alias: "widget",
    remoteName: "widget",
    url: "https://example.test/manifest.json",
  };
  const book = createProbeBook();
  putLinkResult(book, {
    link,
    manifestReachable: true,
    buildVersion: null,
    zipUrl: f.input.url,
    zipHash: f.input.expectedZipHash,
    zipMtime: null,
    exposes: [],
    shared: [],
  });
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(f.bytes));
  const messages: string[] = [];
  const log = createLogger({
    enabled: () => true,
    write: (_level, message) => messages.push(message),
  }).operation("manual");
  const confirmations = createConfirmationStore();
  assert.equal(await verifyTypeInstalls([app], [link], book, confirmations, new Map(), log), true);
  const tasks = messages.filter((message) => message.startsWith("evidence.task.finished"));
  assert.equal(tasks.filter((message) => message.includes("task=archive-comparison")).length, 1);
  assert.equal(tasks.filter((message) => message.includes("task=installed")).length, 3);
  for (const message of tasks) {
    assert.match(message, /operation=1 source=manual/);
    assert.match(message, /durationMs=\d+/);
  }
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(confirmations.install(link)?.zipHash, f.input.expectedZipHash);
});

test("verification downloads a rejected shared archive once per refresh across four consumers", async (t) => {
  const f = archiveFixture(t);
  const apps = Array.from({ length: 4 }, (_, index) => {
    f.write(`consumer-${index}/@mf-types/widget/index.d.ts`, "type Value = 1;");
    return localApp(`consumer-${index}`, path.join(f.root, `consumer-${index}`), {
      consumeTypes: true,
    });
  });
  const links = apps.map((app) => ({
    consumer: app.name,
    alias: "widget",
    remoteName: "widget",
    url: "https://example.test/manifest.json",
  }));
  const book = createProbeBook();
  for (const link of links)
    putLinkResult(book, {
      link,
      manifestReachable: true,
      buildVersion: null,
      zipUrl: "https://example.test/types.zip",
      zipHash: "release",
      zipMtime: null,
      exposes: [],
      shared: [],
    });
  const confirmations = createConfirmationStore();
  const checks = new Map<string, InstallCheck>();
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    attempts++;
    throw new Error("archive unavailable");
  });
  for (let refresh = 1; refresh <= 2; refresh++) {
    const evidence = new Map<string, InstalledEvidence>();
    assert.equal(
      await verifyTypeInstalls(
        apps,
        links,
        book,
        confirmations,
        checks,
        undefined,
        undefined,
        evidence,
      ),
      false,
    );
    assert.equal(attempts, refresh, "each fresh verification batch makes exactly one attempt");
    assert.equal(evidence.size, 4, "every destination retains its independent installed evidence");
    assert.equal(checks.size, 0);
    for (const link of links) assert.equal(confirmations.install(link), null);
  }
});

test("automatic Rslib verification shares a bundled decoder without loading a project substitute", async (t) => {
  const missing = fixture(t);
  const valid = archiveFixture(t);
  const marker = path.join(valid.root, "decoder-loaded");
  valid.write(
    "node_modules/adm-zip/index.js",
    `
    require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded");
    throw new Error("project decoder must not run");
  `,
  );
  valid.write("tsconfig.json", "{}");
  valid.write(
    "rslib.config.ts",
    `
    export default {
      lib: [{ format: 'mf', plugins: [pluginModuleFederation({ name: 'implicit' })] }],
    };
  `,
  );
  const implicit = readAppFolder(valid.root, "development");
  assert.ok(implicit?.consumeTypes);
  missing.write("@mf-types/widget/index.d.ts", "export type Value = 1;");
  valid.write("@mf-types/widget/index.d.ts", "export type Value = 1;");
  const apps = [localApp("missing-sdk", missing.root, { consumeTypes: true }), implicit];
  const links = apps.map((app) => ({
    consumer: app.name,
    alias: "widget",
    remoteName: "widget",
    url: "https://example.test/manifest.json",
  }));
  const book = createProbeBook();
  for (const link of links)
    putLinkResult(book, {
      link,
      manifestReachable: true,
      buildVersion: null,
      zipUrl: valid.input.url,
      zipHash: valid.input.expectedZipHash,
      zipMtime: null,
      exposes: [],
      shared: [],
    });
  let downloads = 0;
  t.mock.method(globalThis, "fetch", async () => {
    downloads++;
    return new Response(valid.bytes);
  });
  const confirmations = createConfirmationStore();
  const checks = new Map<string, InstallCheck>();
  assert.equal(await verifyTypeInstalls(apps, links, book, confirmations, checks), true);
  for (const link of links)
    assert.equal(confirmations.install(link)?.zipHash, valid.input.expectedZipHash);
  assert.equal(downloads, 1);
  assert.equal(fs.existsSync(marker), false);
});

test("archives and installed trees with symlinks cannot be confirmed", async (t) => {
  const f = archiveFixture(t);
  const bytes = f.archive([
    { file: "linked.d.ts", text: "index.d.ts", attr: (0o120777 << 16) >>> 0 },
  ]);
  await assert.rejects(
    createArchiveComparisonBatch()({
      ...f.input,
      expectedZipHash: f.hash(bytes),
      fetchImpl: async () => new Response(bytes),
    }),
    /symlink/,
  );
  const compare = createArchiveComparisonBatch();
  assert.equal((await compare(f.input)).matches, true);
  fs.symlinkSync(path.join(f.root, "one/index.d.ts"), path.join(f.root, "two/linked.d.ts"));
  await assert.rejects(
    compare({ ...f.input, destination: path.join(f.root, "two") }),
    /could not read/,
  );
});

test("verification shares final installed evidence, respects selected links, and rejects output races", async (t) => {
  const f = fixture(t);
  const file = f.write("@mf-types/widget/index.d.ts", "type Value = 1;");
  const app = localApp("shell", f.root, { consumeTypes: true });
  const link = {
    consumer: app.name,
    alias: "widget",
    remoteName: "widget",
    url: "https://example.test/manifest.json",
  };
  const other = { ...link, alias: "unselected" };
  const book = createProbeBook();
  putLinkResult(book, {
    link,
    manifestReachable: true,
    buildVersion: null,
    zipUrl: "https://example.test/types.zip",
    zipHash: "release",
    zipMtime: null,
    exposes: [],
    shared: [],
  });
  const confirmations = createConfirmationStore();
  const checks = new Map<string, InstallCheck>();
  const evidence = new Map<string, InstalledEvidence>();
  const before = await readInstalledEvidenceAsync(path.dirname(file));
  let reads = 0;
  const read = async (destination: string | null, log?: LogContext, fresh = false) => {
    reads++;
    assert.equal(destination, path.dirname(file));
    return readInstalledEvidenceAsync(destination, log, fresh);
  };
  await verifyTypeInstalls(
    [app],
    [link, other],
    book,
    confirmations,
    checks,
    undefined,
    async () => {
      f.write("@mf-types/widget/index.d.ts", "type Value = 200;");
      return { zipHash: "release", filesFingerprint: before.filesFingerprint!, matches: true };
    },
    evidence,
    read,
    new Set([linkProbeId(link)]),
  );
  assert.equal(reads, 2, "initial and final evidence are enough for this refresh");
  assert.equal(confirmations.install(link), null);
  assert.equal(checks.size, 0);
  assert.notEqual(evidence.get(path.dirname(file))?.filesFingerprint, before.filesFingerprint);
  book.links.clear();
  const offline = new Map<string, InstalledEvidence>();
  await verifyTypeInstalls(
    [app],
    [link, other],
    book,
    confirmations,
    checks,
    undefined,
    undefined,
    offline,
    read,
    new Set([linkProbeId(link)]),
  );
  assert.equal(
    offline.size,
    1,
    "offline evidence is still available to observation without rescanning",
  );
});

test("disposing a busy evidence worker rejects queued requests and a later request can restart it", async (t) => {
  const f = fixture(t);
  f.write("src/a.ts", "export const a = 1;");
  const requests = [
    sourceIdentityAsync(f.root, null, "@mf-types"),
    readInstalledEvidenceAsync(path.join(f.root, "missing")),
  ];
  const results = Promise.allSettled(requests);
  disposeEvidenceWorker();
  assert.deepEqual(
    (await results).map((result) => result.status),
    ["rejected", "rejected"],
  );
  assert.deepEqual((await sourceIdentityAsync(f.root, null, "@mf-types")).names, ["src/a.ts"]);
});
