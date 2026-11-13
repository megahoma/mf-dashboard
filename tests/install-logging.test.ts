import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installRemoteTypes } from "../src/features/refetch-types/lib/remote.ts";
import { dependencyTypesTarget, refetchTarget } from "../src/features/refetch-types/lib/targets.ts";
import { createLogger, safeError } from "../src/shared/lib/logging.ts";
import { DiagnosticError } from "../src/shared/models/diagnostic-error.ts";
import type { DiagnosticDetails } from "../src/shared/models/diagnostic-error-types.ts";
import { localApp } from "./support/app.ts";

const url = "https://example.com/manifest.json?token=SECRET#PRIVATE";
const remote = { alias: "widget", name: "widget", url };
const manifest = () =>
  Response.json({
    metaData: {
      publicPath: "https://example.com/",
      types: { zip: "types.zip?token=SECRET#PRIVATE" },
    },
  });

for (const stage of ["manifest", "archive"] as const) {
  test(`Fetch preserves ${stage} HTTP failure through the wrapper without leaking URL secrets`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-install-log-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const messages: string[] = [];
    const log = createLogger({
      enabled: (level) => ["info", "warn", "error"].includes(level),
      write: (_level, text) => messages.push(text),
    }).operation("fetch");
    const status = stage === "manifest" ? 404 : 503;
    const requests: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      requests.push(String(input));
      if (stage === "archive" && String(input).includes("manifest.json")) return manifest();
      return new Response("SECRET response body", { status });
    });
    await assert.rejects(
      async () => {
        try {
          await installRemoteTypes(localApp("shell", root), remote, url, "", undefined, log);
        } catch (error) {
          log.event("error", "types.fetch.failed", safeError(error));
          assert.equal(safeError(error).status, status);
          assert.equal(safeError(error).stage, stage);
          throw error;
        }
      },
      stage === "manifest" ? /unreachable dependency/ : /network: status 503/,
    );
    const failure = messages.find((text) => text.startsWith("types.fetch.failed"));
    assert.ok(failure);
    assert.match(failure, new RegExp(`stage=${stage} reason=http-status status=${status}`));
    assert.equal(messages.join(" ").includes("SECRET"), false);
    assert.equal(messages.join(" ").includes("PRIVATE"), false);
    assert.equal(requests.length, stage === "manifest" ? 1 : 2);
    assert.deepEqual(fs.readdirSync(root), [], "HTTP failure does not create a types destination");
  });
}

test("Fetch retains shell timeout details at Info without exposing the command", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-install-log-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => manifest());
  const messages: string[] = [];
  const log = createLogger({
    enabled: (level) => ["info", "warn", "error"].includes(level),
    write: (_level, text) => messages.push(text),
  }).operation("fetch");
  const { manifestZipUrl } = await import("../src/entities/microfrontend/lib/zip-url.ts");
  const { refetchInstalled } = await import("../src/features/refetch-types/lib/refetch.ts");
  await assert.rejects(
    () =>
      installRemoteTypes(
        localApp("shell", root),
        remote,
        url,
        "fetch SECRET {typesFolder}",
        {
          manifestZipUrl,
          refetchInstalled,
          async runShell() {
            throw new DiagnosticError("timeout 60000 SECRET command", {
              stage: "shell",
              reason: "timeout",
              timeoutMs: 60000,
            });
          },
        },
        log,
      ),
    /timeout 60000/,
  );
  for (const field of ["stage=shell", "reason=timeout", "timeoutMs=60000"])
    assert.ok(messages.some((message) => message.includes(field)));
  assert.equal(messages.join(" ").includes("SECRET"), false);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("unsafe destination details survive Fetch without writing outside the consumer", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-install-log-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => manifest());
  const messages: string[] = [];
  const log = createLogger({ enabled: () => true, write: (_level, text) => messages.push(text) });
  await assert.rejects(
    () =>
      installRemoteTypes(
        localApp("shell", root, { typesFolder: "../SECRET" }),
        remote,
        url,
        "",
        undefined,
        log,
      ),
    /unsafe types folder/,
  );
  assert.match(messages.join(" "), /stage=destination/);
  assert.match(messages.join(" "), /reason=path-escape/);
  assert.equal(messages.join(" ").includes("SECRET"), false);
  assert.deepEqual(fs.readdirSync(root), []);
  assert.throws(
    () => refetchTarget(root, "../SECRET", "@mf-types"),
    (error: unknown) => {
      assert.equal(safeError(error).reason, "unsafe-alias");
      return true;
    },
  );
  assert.throws(
    () => refetchTarget(root, "widget", "/SECRET"),
    (error: unknown) => {
      assert.equal(safeError(error).reason, "unsafe-types-folder");
      return true;
    },
  );
});

test("scoped aliases resolve under the types root and reject unsafe path segments", () => {
  const consumer = path.resolve("consumer-fixture");
  const types = path.join(consumer, "@mf-types");
  assert.equal(refetchTarget(consumer, "widget", "@mf-types"), path.join(types, "widget"));
  assert.equal(
    refetchTarget(consumer, "@fixture/ui-kit", "@mf-types"),
    path.join(types, "@fixture", "ui-kit"),
  );
  for (const alias of [
    "nested/widget",
    "@/widget",
    "@fixture/",
    "@fixture/.",
    "@fixture/..",
    "@fixture/../widget",
    "@fixture//widget",
    "@fixture/widget/child",
    "@fixture\\widget",
    "@fixture/widget:stream",
    "@fixture/widget.",
    "@fixture/CON.d.ts",
    "/@fixture/widget",
    "C:",
    "C:@fixture",
    "d:widget",
  ]) {
    assert.throws(() => refetchTarget(consumer, alias, "@mf-types"), /unsafe remote alias/, alias);
  }
});

test("a scoped install cannot follow a linked scope directory", (t) => {
  const consumer = fs.mkdtempSync(path.join(os.tmpdir(), "mf-types-scope-"));
  t.after(() => fs.rmSync(consumer, { recursive: true, force: true }));
  const types = path.join(consumer, "@mf-types");
  const source = path.join(consumer, "source");
  fs.mkdirSync(types);
  fs.mkdirSync(source);
  fs.symlinkSync(source, path.join(types, "@fixture"), "junction");

  assert.throws(
    () => refetchTarget(consumer, "@fixture/widget", "@mf-types"),
    (error: unknown) => safeError(error).reason === "path-escape",
  );
  assert.deepEqual(fs.readdirSync(source), []);
});

test("a flat alias and a scoped alias cannot share an installation directory", async (t) => {
  const consumer = fs.mkdtempSync(path.join(os.tmpdir(), "mf-types-overlap-"));
  t.after(() => fs.rmSync(consumer, { recursive: true, force: true }));
  const flat = { ...remote, alias: "@Fixture" };
  const scoped = { ...remote, alias: "@fixture/ui-kit" };
  const app = localApp("fixture-client", consumer, { consumeTypes: true, remotes: [flat, scoped] });
  t.mock.method(globalThis, "fetch", async () => manifest());

  await assert.rejects(
    () => installRemoteTypes(app, flat, url, ""),
    /remote aliases share a types directory/,
  );
  assert.throws(
    () => dependencyTypesTarget(app, scoped, [app]),
    /remote aliases share a types directory/,
  );
  assert.deepEqual(fs.readdirSync(consumer), []);
});

test("Fetch protects an overlapping scoped alias in another config with the same real types folder", async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "mf-types-shared-root-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const flat = { ...remote, alias: "@fixture" };
  const scoped = { ...remote, alias: "@fixture/widget" };
  const first = localApp("fixture-flat", folder, { consumeTypes: true, remotes: [flat] });
  const second = localApp("fixture-scoped", folder, {
    consumeTypes: true,
    typesFolder: "linked-types",
    remotes: [scoped],
  });
  const root = path.join(folder, first.typesFolder);
  const installed = path.join(root, scoped.alias, "index.d.ts");
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(installed, "previous");
  fs.symlinkSync(root, path.join(folder, second.typesFolder), "junction");
  const requests = t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    assert.equal(String(input), url);
    return manifest();
  });

  await assert.rejects(
    () => installRemoteTypes(first, flat, url, "", undefined, undefined, [first, second]),
    /remote aliases share a types directory/,
  );
  assert.equal(requests.mock.callCount(), 1);
  assert.equal(fs.readFileSync(installed, "utf8"), "previous");
});

test("Fetch preserves a symlink another config uses to reach its scoped types", async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "mf-types-link-route-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const flat = { ...remote, alias: "@fixture" };
  const scoped = { ...remote, alias: "@library/widget" };
  const first = localApp("fixture-flat", folder, { consumeTypes: true, remotes: [flat] });
  const second = localApp("fixture-scoped", folder, {
    consumeTypes: true,
    typesFolder: "linked-types",
    remotes: [scoped],
  });
  const root = path.join(folder, first.typesFolder);
  const link = path.join(root, flat.alias, "types-link");
  const installed = path.join(root, scoped.alias, "index.d.ts");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(installed, "previous");
  fs.symlinkSync(root, link, "junction");
  fs.symlinkSync(link, path.join(folder, second.typesFolder), "junction");
  const fetch = t.mock.method(globalThis, "fetch", async () => manifest());

  await assert.rejects(
    () => installRemoteTypes(first, flat, url, "", undefined, undefined, [first, second]),
    /remote aliases share a types directory/,
  );
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(
    fs.readFileSync(path.join(folder, second.typesFolder, scoped.alias, "index.d.ts"), "utf8"),
    "previous",
  );
});

test(
  "overlap checks keep links reached before parent segments",
  { skip: process.platform === "win32" },
  (t) => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "mf-types-relative-route-"));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const flat = { ...remote, alias: "@fixture" };
    const scoped = { ...remote, alias: "@library/widget" };
    const first = localApp("fixture-flat", folder, { consumeTypes: true, remotes: [flat] });
    const second = localApp("fixture-scoped", folder, {
      consumeTypes: true,
      typesFolder: "linked-types",
      remotes: [scoped],
    });
    const jump = path.join(first.typesFolder, flat.alias, "jump");
    fs.mkdirSync(path.join(folder, "actual", "a", "b"), { recursive: true });
    fs.mkdirSync(path.join(folder, "actual", "types"));
    fs.mkdirSync(path.join(folder, first.typesFolder, "types"), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(folder, jump)));
    fs.symlinkSync(path.join(folder, "actual", "a", "b"), path.join(folder, jump), "dir");
    fs.symlinkSync(`${jump}/../../types`, path.join(folder, second.typesFolder), "dir");

    assert.throws(
      () => dependencyTypesTarget(first, flat, [first, second]),
      /remote aliases share a types directory/,
    );
  },
);

test("overlap checks compare Unicode spellings of the same existing folder", (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "mf-types-unicode-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const typesFolder = "caf\u00e9";
  const alternate = typesFolder.normalize("NFD");
  fs.mkdirSync(path.join(folder, typesFolder));
  const flat = { ...remote, alias: "@fixture" };
  const scoped = { ...remote, alias: "@fixture/widget" };
  const first = localApp("fixture-flat", folder, {
    consumeTypes: true,
    typesFolder,
    remotes: [flat],
  });
  const second = localApp("fixture-scoped", folder, {
    consumeTypes: true,
    typesFolder: alternate,
    remotes: [scoped],
  });
  const select = () => dependencyTypesTarget(first, flat, [first, second]);

  if (fs.existsSync(path.join(folder, alternate)))
    assert.throws(select, /remote aliases share a types directory/);
  else assert.equal(select(), path.join(folder, typesFolder, flat.alias));
});

test(
  "a flat alias with a trailing dot has a distinct POSIX path",
  { skip: process.platform === "win32" },
  () => {
    const folder = path.resolve("consumer-fixture");
    const flat = { ...remote, alias: "@fixture." };
    const scoped = { ...remote, alias: "@fixture/widget" };
    const app = localApp("fixture-client", folder, { consumeTypes: true, remotes: [flat, scoped] });

    assert.equal(
      dependencyTypesTarget(app, flat, [app]),
      path.join(folder, app.typesFolder, flat.alias),
    );
    assert.equal(
      dependencyTypesTarget(app, scoped, [app]),
      path.join(folder, app.typesFolder, scoped.alias),
    );
  },
);

test("a config with type consumption disabled does not reserve dependency paths", () => {
  const folder = path.resolve("consumer-fixture");
  const flat = { ...remote, alias: "@fixture" };
  const scoped = { ...remote, alias: "@fixture/widget" };
  const first = localApp("fixture-flat", folder, { consumeTypes: true, remotes: [flat] });
  const second = localApp("fixture-scoped", folder, { consumeTypes: false, remotes: [scoped] });

  assert.equal(
    dependencyTypesTarget(first, flat, [first, second]),
    path.join(folder, first.typesFolder, flat.alias),
  );
});

test("shared scoped targets require both configs to refer to the same remote", (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "mf-shared-scoped-types-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const scoped = { ...remote, alias: "@fixture/widget" };
  const first = localApp("fixture-first", folder, { consumeTypes: true, remotes: [scoped] });
  const second = localApp("fixture-second", folder, {
    consumeTypes: true,
    typesFolder: "linked-types",
    remotes: [{ ...scoped }],
  });
  const types = path.join(folder, first.typesFolder);
  const target = path.join(types, scoped.alias);
  const backing = path.join(types, "backing");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(backing);
  fs.symlinkSync(backing, target, "junction");
  fs.symlinkSync(types, path.join(folder, second.typesFolder), "junction");
  const different = { ...scoped, url: "https://assets.example.test/mf-manifest.json" };
  const third = localApp("fixture-third", folder, { consumeTypes: true, remotes: [different] });
  assert.equal(dependencyTypesTarget(first, scoped, [first, second]), target);
  assert.throws(
    () => dependencyTypesTarget(first, scoped, [first, third]),
    /remote aliases share a types directory/,
  );
});

test("HTTP timeout while reading an archive keeps its stage and configured timeout", async (t) => {
  const { installTypesArchive } = await import("../src/entities/federated-types/lib/install.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-install-log-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(
    () =>
      installTypesArchive({
        url: "https://example.com/types.zip?token=SECRET",
        appDir: root,
        destination: path.join(root, "types"),
        timeoutMs: 5,
        fetchImpl: async (_url, options) =>
          new Response(
            new ReadableStream({
              start(controller) {
                options?.signal?.addEventListener(
                  "abort",
                  () => controller.error(options.signal?.reason),
                  { once: true },
                );
              },
            }),
          ),
      }),
    (error: unknown) => {
      assert.equal(safeError(error).stage, "archive");
      assert.equal(safeError(error).reason, "timeout");
      assert.equal(safeError(error).timeoutMs, 5);
      return true;
    },
  );
  assert.deepEqual(fs.readdirSync(root), []);
});

test("manifest timeout remains identifiable after unreachable-dependency wrapping", async (t) => {
  t.mock.method(AbortSignal, "timeout", () =>
    AbortSignal.abort(new DOMException("SECRET", "TimeoutError")),
  );
  t.mock.method(globalThis, "fetch", async (_url: unknown, options?: RequestInit) => {
    throw options?.signal?.reason;
  });
  await assert.rejects(
    () => installRemoteTypes(localApp("shell", "/unused"), remote, url, ""),
    (error: unknown) => {
      const fields = safeError(error);
      assert.equal(fields.stage, "manifest");
      assert.equal(fields.reason, "timeout");
      assert.equal(fields.timeoutMs, 10000);
      assert.equal(JSON.stringify(fields).includes("SECRET"), false);
      return true;
    },
  );
});

test("safeError reads only known structured fields, never arbitrary error properties or causes", () => {
  const untrusted = Object.assign(new Error("SECRET"), {
    stage: "archive",
    reason: "http-status",
    status: 503,
    cause: new Error("SECRET"),
  });
  assert.equal(safeError(untrusted).status, undefined);
  const error = new DiagnosticError(
    "SECRET",
    {
      stage: "SECRET",
      reason: "SECRET",
      status: Infinity,
      timeoutMs: -1,
      exitCode: NaN,
      body: "SECRET",
      url: "https://user:SECRET@example.com/?token=SECRET",
    } as unknown as DiagnosticDetails,
    { cause: untrusted },
  );
  const fields = safeError(error);
  assert.equal(fields.stage, undefined);
  assert.equal(fields.reason, undefined);
  assert.equal(fields.status, undefined);
  assert.equal(fields.timeoutMs, undefined);
  assert.equal(fields.exitCode, undefined);
  assert.equal(JSON.stringify(fields).includes("SECRET"), false);
});
