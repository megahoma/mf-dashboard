import { describeLink } from "../src/entities/federated-types/observe.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { createLogger, safeError, safeUrl } from "../src/shared/logging.ts";
import { DashboardSession } from "../src/widgets/mf-dashboard-tree/session.ts";
import { localApp } from "./support/app.ts";
import {
  createProbeBook,
  createProbeCycle,
  type Net,
} from "../src/entities/microfrontend/probe.ts";

test("logs strip URL secrets, reject invalid URLs and escape external line breaks", () => {
  const messages: string[] = [];
  const log = createLogger({ enabled: () => true, write: (_level, text) => messages.push(text) });
  const url = "https://user:password@example.com/types.zip?token=secret#private";
  log.event("trace", "request", {
    url,
    app: "widget\nforged",
    invalidUrl: "secret",
    urlMatches: false,
    variableUrl: "https://${TOKEN}/secret",
  });
  const error = Object.assign(new Error("shell: TOKEN=secret curl " + url), {
    code: "EACCES",
    response: "password",
  });
  error.stack =
    error.message + "\n    at run (/tmp/extension.js:12:3)\n    at fetch (" + url + ":1:2)";
  log.event("error", "failed", safeError(error));
  assert.equal(safeUrl(url), "https://example.com/types.zip");
  const text = messages.join(" ");
  for (const value of ["user", "password", "token=", "secret", "private", "TOKEN", "shell:"])
    assert.equal(text.includes(value), false, value);
  assert.equal(
    messages.some((message) => message.includes("\n")),
    false,
  );
  assert.match(text, /urlMatches=false/);
  assert.match(text, /EACCES/);
  assert.match(text, /extension.js:12:3/);
  assert.match(text, /invalidUrl=\[invalid-url\]/);
});

test("disabled logs do not evaluate fields, and throwing sinks cannot break work", () => {
  const disabled = createLogger({ enabled: () => false, write: () => assert.fail() });
  disabled.event("trace", "ignored", () => {
    assert.fail("expensive formatting");
  });
  for (const sink of [
    {
      enabled: () => {
        throw new Error("broken");
      },
      write() {},
    },
    {
      enabled: () => true,
      write: () => {
        throw new Error("broken");
      },
    },
  ])
    assert.doesNotThrow(() => createLogger(sink).operation("test").event("info", "completed"));
});

test("nested events share an operation and separate actions get distinct ids", () => {
  const messages: string[] = [];
  const root = createLogger({ enabled: () => true, write: (_level, text) => messages.push(text) });
  const first = root.operation("manual");
  first.event("debug", "probe.started");
  first.event("trace", "manifest.request");
  root.operation("timer").event("debug", "probe.started");
  assert.match(messages[0], /operation=1 source=manual/);
  assert.match(messages[1], /operation=1 source=manual/);
  assert.match(messages[2], /operation=2 source=timer/);
});

test("probe logging preserves requests, retries and conditional ZIP reuse", async () => {
  const execute = async (enabled: boolean, throws = false) => {
    const requests: string[] = [];
    const messages: string[] = [];
    const log = createLogger({
      enabled: () => enabled,
      write: (_level, text) => {
        if (throws) throw new Error("sink");
        messages.push(text);
      },
    }).operation("test");
    let failed = true;
    const net: Net = {
      connect: async () => true,
      async get(url, init) {
        requests.push(`${url}:${init?.ifModifiedSince ?? "none"}`);
        if (url.endsWith(".json"))
          return {
            ok: true,
            status: 200,
            json: { metaData: { publicPath: "http://localhost/", types: { zip: "types.zip" } } },
            body: null,
            lastModified: null,
          };
        if (failed) {
          failed = false;
          throw new Error("transient secret response");
        }
        if (init)
          return {
            ok: true,
            status: 304,
            notModified: true,
            json: null,
            body: null,
            lastModified: 1000,
          };
        return {
          ok: true,
          status: 200,
          json: null,
          body: new Uint8Array([1, 2]),
          lastModified: 1000,
        };
      },
    };
    const book = createProbeBook();
    const cycle = createProbeCycle(net, book);
    const input = {
      apps: [],
      links: [],
      extraManifestUrls: [
        "http://localhost/a.json",
        "http://localhost/b.json",
        "http://localhost/c.json",
      ],
      log,
    };
    await cycle.start(input);
    await cycle.start(input);
    return { requests, messages, fact: book.zips.get("http://localhost/types.zip") };
  };
  const quiet = await execute(false);
  const logged = await execute(true);
  const broken = await execute(true, true);
  assert.deepEqual(logged.requests, quiet.requests);
  assert.deepEqual(broken.requests, quiet.requests);
  assert.deepEqual(logged.fact, quiet.fact);
  assert.deepEqual(broken.fact, quiet.fact);
  assert.equal(logged.messages.filter((message) => message.includes("zip.failed")).length, 1);
  assert.equal(
    logged.messages.filter((message) => message.includes("zip.response")).length,
    2,
    "only successful HTTP responses produce zip.response (200 and 304)",
  );
  assert.ok(logged.messages.some((message) => message.includes("reason=cycle-cache")));
  assert.ok(logged.messages.some((message) => message.includes("reason=not-modified")));
  assert.ok(
    logged.messages.some((message) => message.includes("manifestRequests=3 zipRequests=1")),
  );
});

test("timer failures are visible at Info with safe duplicate-name details and preserve the book", async () => {
  const messages: string[] = [];
  const log = createLogger({
    enabled: (level) => ["info", "warn", "error"].includes(level),
    write: (level, text) => messages.push(`${level} ${text}`),
  });
  const book = createProbeBook();
  book.zips.set("http://localhost/old.zip", { zipHash: "old", zipMtime: 1000 });
  let duplicate = true;
  const app = localApp("widget", "/unused");
  const session = new DashboardSession(
    {
      readSettings: () => ({
        apps: {},
        envMode: "development",
        ignorePaths: [],
        extraManifestUrls: [],
        structure: "tree",
      }),
      roots: () => [{ name: "workspace", path: "/unused" }],
      loadKnown: () => (duplicate ? [app, app] : [app]),
      async probe() {
        throw new Error("SECRET response body");
      },
      scan: () => ({}),
      writeApps() {},
    },
    book,
    () => {},
    log,
  );
  await assert.rejects(() => session.refresh("timer"), /duplicate federation name/);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /error refresh.failed operation=1 source=timer/);
  assert.match(messages[0], /reason=duplicate-federation-name app=widget/);
  duplicate = false;
  await assert.rejects(() => session.refresh("timer"), /SECRET/);
  assert.equal(messages.length, 2);
  assert.match(messages[1], /error refresh.failed operation=2 source=timer/);
  assert.equal(messages.join(" ").includes("SECRET"), false);
  assert.deepEqual(book.zips.get("http://localhost/old.zip"), { zipHash: "old", zipMtime: 1000 });
  assert.deepEqual(session.loaded, []);
  assert.equal(session.probeRunning, false);
});

test("discovery reports duplicate workspace and federation names without writing settings", async () => {
  for (const duplicateRoots of [true, false]) {
    const messages: string[] = [];
    const log = createLogger({
      enabled: (level) => ["info", "warn", "error"].includes(level),
      write: (_level, text) => messages.push(text),
    });
    const session = new DashboardSession(
      {
        readSettings: () => ({
          apps: {},
          envMode: "development",
          ignorePaths: [],
          extraManifestUrls: [],
          structure: "tree",
        }),
        roots: () => [
          { name: "one", path: "/one" },
          { name: duplicateRoots ? "one" : "two", path: "/two" },
        ],
        scan: (root) => ({ widget: localApp("widget", `${root}/widget`) }),
        loadKnown: () => assert.fail("invalid discovery must not load apps"),
        probe: () => assert.fail("invalid discovery must not probe"),
        writeApps: () => assert.fail("invalid discovery must not write settings"),
      },
      createProbeBook(),
      () => {},
      log,
    );
    await assert.rejects(
      () => session.discover(),
      duplicateRoots ? /workspace folder names must be unique/ : /duplicate federation name/,
    );
    const failure = messages.find((text) => text.startsWith("discovery.failed"));
    assert.ok(failure);
    assert.match(
      failure,
      duplicateRoots
        ? /reason=duplicate-workspace-folder-name/
        : /reason=duplicate-federation-name app=widget/,
    );
    assert.deepEqual(session.loaded, []);
  }
});

test("type diagnostics explain fingerprint mismatch without recording evidence bytes", () => {
  const messages: string[] = [];
  const log = createLogger({ enabled: () => true, write: (_level, text) => messages.push(text) });
  const status = describeLink(
    {
      consumeTypes: true,
      producer: { generateTypes: true, sourceSavedAt: 100 },
      producerZipMtime: 200,
      linkZipHash: "ZIP_SECRET",
      linkZipReachable: true,
      linkUrl: "https://example.com/types.json?secret",
      generationConfirmed: true,
      installConfirmation: {
        zipHash: "ZIP_SECRET",
        filesFingerprint: "OLD_SECRET",
        url: "https://example.com/types.json?secret",
      },
      checkedAt: 1000,
      typesSettleMs: 0,
      installed: { folderExists: true, filesFingerprint: "NEW_SECRET" },
    },
    log,
  );
  assert.equal(status, "unfetched");
  assert.match(messages[0], /sourceFreshness=fresh installedFreshness=stale/);
  assert.match(messages[0], /zipMatches=true filesMatch=false urlMatches=true/);
  assert.equal(messages[0].includes("SECRET"), false);
});
