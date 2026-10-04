import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installRemoteTypes } from "../src/features/refetch-types/remote.ts";
import { refetchTarget } from "../src/features/refetch-types/refetch.ts";
import { createLogger, safeError } from "../src/shared/logging.ts";
import { DiagnosticError, type DiagnosticDetails } from "../src/shared/diagnostic-error.ts";
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
  const { manifestZipUrl } = await import("../src/features/rebuild-types/zip-url.ts");
  const { refetchInstalled } = await import("../src/features/refetch-types/refetch.ts");
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

test("HTTP timeout while reading an archive keeps its stage and configured timeout", async (t) => {
  const { installTypesArchive } = await import("../src/entities/federated-types/install.ts");
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
