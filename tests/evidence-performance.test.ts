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
  createProbeBook,
  linkProbeId,
  putLinkResult,
} from "../src/entities/microfrontend/index.ts";
import { verifyTypeInstalls, type InstallCheck } from "../src/features/observe-types/verify.ts";
import { diagnosticFields } from "../src/shared/diagnostic-error.ts";
import { createLogger, type LogContext } from "../src/shared/logging.ts";
import { localApp } from "./support/app.ts";

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
  const extracted = path.join(f.root, "extractions.log");
  f.write("package.json", "{}");
  // A small archive adapter makes validation/extraction counts observable across the worker boundary.
  f.write(
    "node_modules/adm-zip/index.js",
    `
    const fs=require('node:fs'), path=require('node:path');
    module.exports=class {
      constructor(bytes){this.records=JSON.parse(bytes.subarray(4).toString());}
      getEntries(){return this.records.map(r=>({entryName:r.file,isDirectory:false,header:{attr:r.attr||0}}));}
      extractAllTo(folder){
        fs.appendFileSync(${JSON.stringify(extracted)}, 'extract\\n');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30);
        for(const r of this.records){const file=path.join(folder,r.file);fs.mkdirSync(path.dirname(file),{recursive:true});
          if(r.symlink)fs.symlinkSync(r.symlink,file);else fs.writeFileSync(file,r.text);}
      }
    };
  `,
  );
  const archive = (
    records: { file: string; text: string; attr?: number; symlink?: string }[] = [
      { file: "index.d.ts", text: "export type Value = 1;" },
    ],
  ) => Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from(JSON.stringify(records))]);
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
    extractions: () =>
      fs.existsSync(extracted) ? fs.readFileSync(extracted, "utf8").trim().split("\n").length : 0,
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

test("one batch downloads and extracts each URL/hash once but compares every destination independently", async (t) => {
  const f = archiveFixture(t);
  const compare = createArchiveComparisonBatch();
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
  assert.equal(f.extractions(), 1);
  await compare({ ...f.input, url: "https://example.test/other.zip" });
  assert.equal(f.downloads(), 2, "URL changes cannot reuse unrelated archive evidence");
  assert.equal(f.extractions(), 2);
});

test("archive batch retains failures and a new batch permits retry", async (t) => {
  const f = archiveFixture(t);
  const compare = createArchiveComparisonBatch();
  await assert.rejects(compare({ ...f.input, expectedZipHash: "old-hash" }), /archive changed/);
  assert.equal(f.extractions(), 0);
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
  assert.equal(f.extractions(), 0);
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

test("verification logs archive extraction and internal installed reads in the same operation", async (t) => {
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
  assert.equal(tasks.filter((message) => message.includes("task=archive")).length, 1);
  assert.equal(tasks.filter((message) => message.includes("task=installed")).length, 3);
  for (const message of tasks) {
    assert.match(message, /operation=1 source=manual/);
    assert.match(message, /durationMs=\d+/);
  }
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(f.extractions(), 1);
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

test("a consumer without a decoder does not suppress shared archive verification for a valid peer", async (t) => {
  const missing = fixture(t);
  const valid = archiveFixture(t);
  missing.write("@mf-types/widget/index.d.ts", "export type Value = 1;");
  valid.write("@mf-types/widget/index.d.ts", "export type Value = 1;");
  const apps = [
    localApp("missing-sdk", missing.root, { consumeTypes: true }),
    localApp("valid-sdk", valid.root, { consumeTypes: true }),
  ];
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
  assert.equal(confirmations.install(links[0]), null);
  assert.equal(confirmations.install(links[1])?.zipHash, valid.input.expectedZipHash);
  assert.equal(downloads, 1);
  assert.equal(valid.extractions(), 1);
  // With cached valid evidence available, the decoder-free consumer can use that same proof next time.
  const compare = createArchiveComparisonBatch();
  const first = await compare(valid.input);
  assert.equal(
    (
      await compare({
        ...valid.input,
        appDir: missing.root,
        destination: path.join(missing.root, "@mf-types/widget"),
      })
    ).matches,
    true,
  );
  assert.equal(first.matches, true);
  assert.equal(valid.extractions(), 2, "a successful batch never decodes the same ZIP again");
});

test("post-extraction and installed symlink guards remain active with shared archive fingerprints", async (t) => {
  const f = archiveFixture(t);
  const bytes = f.archive([
    { file: "linked.d.ts", text: "", symlink: path.join(f.root, "one/index.d.ts") },
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
