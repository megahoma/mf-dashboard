import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  compareInstalledArchive,
  confirmInstalledArchive,
  createConfirmationStore,
  describeLink,
  installedFreshness,
  readInstalledEvidence,
} from "../src/entities/federated-types/index.ts";
import {
  createProbeBook,
  linkProbeId,
  putLinkResult,
} from "../src/entities/microfrontend/index.ts";
import { verifyTypeInstalls, type InstallCheck } from "../src/features/observe-types/verify.ts";
import { dashboardNodes } from "../src/widgets/mf-dashboard-tree/presentation.ts";
import { terms } from "../src/shared/config/index.ts";
import { localApp } from "./support/app.ts";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-watch-evidence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const destination = path.join(root, "@mf-types", "paint");
  fs.mkdirSync(destination, { recursive: true });
  const file = path.join(destination, "index.d.ts");
  fs.writeFileSync(file, "export type Swatch = 'blue';");
  const link = {
    consumer: "workshop",
    alias: "paint",
    remoteName: "palette",
    url: "http://localhost:4401/mf-manifest.json",
  };
  const apps = [
    localApp("workshop", root, {
      consumeTypes: true,
      remotes: [{ alias: link.alias, name: link.remoteName, url: link.url }],
    }),
    localApp("palette", path.join(root, "producer")),
  ];
  const book = createProbeBook();
  const publish = (zipHash: string) =>
    putLinkResult(book, {
      link,
      manifestReachable: true,
      buildVersion: null,
      zipUrl: "http://localhost:4401/types.zip",
      zipHash,
      zipMtime: 2000,
      exposes: [],
      shared: [],
    });
  publish("release-one");
  const confirmations = createConfirmationStore();
  const checks = new Map<string, InstallCheck>();
  const fingerprint = () => readInstalledEvidence(destination).filesFingerprint!;
  return { root, destination, file, link, apps, book, publish, confirmations, checks, fingerprint };
}

test("external watch installs are verified, cached and rechecked when files or archive change", async (t) => {
  const f = fixture(t);
  let matches = false;
  let comparisons = 0;
  const compare: Parameters<typeof verifyTypeInstalls>[6] = async (input) => {
    comparisons++;
    assert.equal(input.destination, f.destination);
    assert.equal(input.appDir, f.root);
    return {
      zipHash: f.book.links.get(linkProbeId(f.link))!.zipHash!,
      filesFingerprint: f.fingerprint(),
      matches,
    };
  };
  const verify = () =>
    verifyTypeInstalls(f.apps, [f.link], f.book, f.confirmations, f.checks, undefined, compare);
  assert.equal(await verify(), false);
  assert.equal(f.checks.get(linkProbeId(f.link))?.matches, false);
  assert.equal(f.confirmations.install(f.link), null);
  await verify();
  assert.equal(comparisons, 1, "an unchanged mismatch does not download again");
  matches = true;
  fs.writeFileSync(f.file, "export type Swatch = 'violet';");
  assert.equal(await verify(), true);
  assert.equal(f.confirmations.install(f.link)?.filesFingerprint, f.fingerprint());
  await verify();
  assert.equal(comparisons, 2, "a confirmed install does not download again");
  f.publish("release-two");
  matches = false;
  assert.equal(await verify(), false);
  assert.equal(comparisons, 3);
  assert.equal(f.confirmations.install(f.link)?.zipHash, "release-one");
  fs.writeFileSync(f.file, "export type Swatch = 'green';");
  matches = true;
  assert.equal(await verify(), true);
  assert.equal(f.confirmations.install(f.link)?.zipHash, "release-two");
});

test("verification does not confirm a moving archive, changing output or a failed comparison", async (t) => {
  const f = fixture(t);
  for (const mode of ["archive", "files", "failure"]) {
    const before = f.fingerprint();
    await verifyTypeInstalls(
      f.apps,
      [f.link],
      f.book,
      f.confirmations,
      f.checks,
      undefined,
      async () => {
        if (mode === "failure") throw new Error("network unavailable");
        if (mode === "files") fs.writeFileSync(f.file, "export type Swatch = 'orange';");
        return {
          zipHash: mode === "archive" ? "moving-release" : "release-one",
          filesFingerprint: before,
          matches: true,
        };
      },
    );
    assert.equal(f.confirmations.install(f.link), null, mode);
    assert.equal(f.checks.size, 0, mode);
  }
  f.checks.set("removed-link", {
    zipHash: "old",
    filesFingerprint: "old",
    url: f.link.url,
    matches: true,
  });
  f.apps[0].consumeTypes = false;
  await verifyTypeInstalls(
    f.apps,
    [f.link],
    f.book,
    f.confirmations,
    f.checks,
    undefined,
    async () => {
      throw new Error("disabled consumption must not verify");
    },
  );
  assert.equal(f.checks.size, 0);
});

test("stopped applications expose local type changes without inventing offline freshness", (t) => {
  const f = fixture(t);
  const savedFingerprint = f.fingerprint();
  f.confirmations.saveInstall(f.link, savedFingerprint, "release-one");
  f.book.links.clear();
  const status = () =>
    describeLink({
      consumeTypes: true,
      producer: { generateTypes: true, sourceSavedAt: null },
      producerZipMtime: null,
      linkZipHash: null,
      linkZipReachable: false,
      linkUrl: f.link.url,
      generationConfirmed: false,
      installConfirmation: f.confirmations.install(f.link),
      installed: readInstalledEvidence(f.destination),
      checkedAt: Date.now(),
      typesSettleMs: 0,
    });
  assert.equal(
    status(),
    "unknown",
    "unchanged local files do not prove the current remote release",
  );
  fs.writeFileSync(f.file, "export type Swatch = 'magenta';");
  assert.equal(status(), "changed");
  const nodes = dashboardNodes({
    loaded: f.apps,
    extraUrls: [],
    structure: "tree",
    terms,
    book: f.book,
    pending: new Set(),
    refetchErrors: new Set(),
    scriptGaps: new Set(),
    rebuildErrors: new Map(),
    typesForLink: status,
    actionFor: () => null,
  });
  const row = nodes.find((node) => node.name === "workshop")!.children[0];
  assert.equal(row.kind, "silent");
  assert.equal(row.contextValue, "silent");
  assert.ok(row.description.includes(terms.silent));
  assert.ok(row.description.includes(`@mf-types: ${terms.typesChanged}`));
  assert.ok(row.tooltip.includes(terms.typesChanged));
  fs.unlinkSync(f.file);
  assert.equal(status(), "unfetched", "an empty directory is not an installed type set");
  fs.rmSync(f.destination, { recursive: true });
  assert.equal(status(), "unfetched", "missing files are visible without a reachable ZIP");
  assert.equal(
    installedFreshness({
      folderExists: true,
      filesFingerprint: "",
      zipHash: null,
      url: f.link.url,
      confirmation: f.confirmations.install(f.link),
    }),
    "unknown",
  );
});

test("a verified content match takes priority over an older install record", () => {
  const input = {
    folderExists: true,
    filesFingerprint: "new-files",
    zipHash: "new-archive",
    url: "https://example.test/manifest.json",
    confirmation: {
      filesFingerprint: "old-files",
      zipHash: "old-archive",
      url: "https://example.test/manifest.json",
    },
  };
  assert.equal(installedFreshness({ ...input, archiveMatches: true }), "fresh");
  assert.equal(
    installedFreshness({ ...input, confirmation: null, archiveMatches: false }),
    "stale",
  );
});

test("archive comparison reports content equality without rewriting watch output", async (t) => {
  const f = fixture(t);
  const sdk = path.join(f.root, "node_modules", "adm-zip");
  fs.mkdirSync(sdk, { recursive: true });
  fs.writeFileSync(path.join(f.root, "package.json"), "{}");
  fs.writeFileSync(
    path.join(sdk, "index.js"),
    `const fs=require('node:fs'),path=require('node:path');
    module.exports=class {
      constructor(blob){this.records=JSON.parse(blob.subarray(4).toString());}
      getEntries(){return this.records.map(record=>({entryName:record.file,isDirectory:false}));}
      extractAllTo(folder){for(const record of this.records){const target=path.join(folder,record.file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,record.text);}}
    };`,
  );
  const archive = Buffer.concat([
    Buffer.from([0x50, 0x4b, 3, 4]),
    Buffer.from(JSON.stringify([{ file: "index.d.ts", text: fs.readFileSync(f.file, "utf8") }])),
  ]);
  const input = {
    appDir: f.root,
    destination: f.destination,
    url: "https://example.test/types.zip",
    fetchImpl: async () => new Response(archive),
  };
  const originalMtime = fs.statSync(f.file).mtimeMs;
  assert.equal((await compareInstalledArchive(input)).matches, true);
  assert.equal(fs.statSync(f.file).mtimeMs, originalMtime);
  fs.writeFileSync(f.file, "export type Swatch = 'different';");
  assert.equal((await compareInstalledArchive(input)).matches, false);
  assert.equal(fs.readFileSync(f.file, "utf8"), "export type Swatch = 'different';");
  await assert.rejects(confirmInstalledArchive(input), /do not match the archive/);
});
