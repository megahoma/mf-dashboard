import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { localApp } from "./support/app.ts";
import * as vscode from "./support/vscode.ts";
import { terms } from "../src/shared/config/index.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "vscode") {
      return { url: new URL("./support/vscode.ts", import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { ManifestDocuments } = await import("../src/features/open-manifest/documents.ts");
const { MfDashboardProvider } = await import("../src/widgets/mf-dashboard-tree/provider.ts");

test("shared producers are scanned once and invalidated with the link status cache", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-producer-cache-"));
  const producer = localApp("producer", root);
  const source = path.join(root, "app.ts");
  fs.writeFileSync(source, "export const app = 1;");
  const provider = new MfDashboardProvider(() => terms);
  t.after(() => {
    provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  provider.session.loaded = [
    producer,
    localApp("a", "/a", { consumeTypes: true }),
    localApp("b", "/b", { consumeTypes: true }),
  ];
  const linkA = {
    consumer: "a",
    alias: "producer",
    remoteName: "producer",
    url: "http://localhost:4100/mf-manifest.json",
  };
  const linkB = { ...linkA, consumer: "b" };
  const read = t.mock.method(fs, "readFileSync");
  const count = () => read.mock.calls.filter((call) => String(call.arguments[0]) === source).length;
  provider.session.typesForLink(linkA);
  provider.session.typesForLink(linkB);
  assert.equal(count(), 1);
  provider.session.typesForLink(linkA);
  assert.equal(count(), 1);
  fs.writeFileSync(source, "export const app = 2;");
  provider.session.beforeRefreshChange();
  provider.session.typesForLink(linkB);
  provider.session.typesForLink(linkA);
  assert.equal(count(), 2);
  provider.session.onRefreshFailed();
  provider.session.typesForLink(linkA);
  assert.equal(count(), 3);
});

test("manifest documents update in place and keep credentials out of their URI", () => {
  const documents = new ManifestDocuments();
  const events: string[] = [];
  const listener = documents.onDidChange((uri) => events.push(uri.toString()));
  try {
    const url = "https://user:password@example.com/mf-manifest.json?token=secret";
    const first = documents.uri("widget", url, "old");
    const second = documents.uri("widget", url, "new");
    assert.equal(first.toString(), second.toString());
    assert.equal(documents.provideTextDocumentContent(first), "new");
    assert.equal(first.path, "/widget.json");
    assert.match(first.query, /^[a-f0-9]{64}$/);
    for (const secret of ["user", "password", "example.com", "token", "secret"]) {
      assert.equal(first.toString().includes(secret), false);
    }
    const other = documents.uri("widget", `${url}&other=1`, "other");
    assert.notEqual(other.toString(), first.toString());
    assert.equal(documents.provideTextDocumentContent(first), "new");
    assert.equal(documents.provideTextDocumentContent(other), "other");
    assert.deepEqual(events, [first.toString(), second.toString(), other.toString()]);
    documents.dispose();
    assert.equal(documents.provideTextDocumentContent(first), "");
  } finally {
    listener.dispose();
    documents.dispose();
  }
});

test("manifest command rejects unconfigured extra URLs and separates fetch and editor failures", async (t) => {
  const provider = new MfDashboardProvider(() => terms);
  const url = "https://configured.example/mf-manifest.json";
  const errors: string[] = [];
  const requests: string[] = [];
  t.mock.method(vscode.window, "showErrorMessage", (message: string) => errors.push(message));
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    requests.push(String(input));
    return new Response('{"name":"widget"}', { headers: { "content-type": "application/json" } });
  });
  const show = t.mock.method(vscode.window, "showTextDocument", async () => {});
  try {
    provider.session.extraUrls = [url];
    const extra = provider.session.nodes()[0];
    await provider.openManifest({ ...extra, id: "extra:https://unconfigured.example/secret" });
    await provider.openManifest(undefined);
    assert.deepEqual(requests, []);
    await provider.openManifest(extra);
    assert.deepEqual(requests, [url]);
    assert.equal(show.mock.callCount(), 1);
    assert.deepEqual(errors, []);

    show.mock.mockImplementation(async () => {
      throw new Error("editor failed");
    });
    await provider.openManifest(extra);
    assert.equal(errors.pop(), "MF dashboard: could not open manifest preview");

    fetchMock.mock.mockImplementation(async () => new Response("missing", { status: 404 }));
    await provider.openManifest(extra);
    assert.equal(errors.pop(), "MF dashboard: manifest is not reachable (HTTP 404)");
    fetchMock.mock.mockImplementation(async () => {
      throw new Error("timeout");
    });
    await provider.openManifest(extra);
    assert.equal(errors.pop(), "MF dashboard: manifest request timed out");
    fetchMock.mock.mockImplementation(async () => {
      throw new Error("ECONNREFUSED");
    });
    await provider.openManifest(extra);
    assert.equal(errors.pop(), "MF dashboard: manifest network error");
    assert.equal(show.mock.callCount(), 2);

    provider.session.extraUrls = [];
    const count = fetchMock.mock.callCount();
    await provider.openManifest(extra);
    assert.equal(fetchMock.mock.callCount(), count);
  } finally {
    provider.dispose();
  }
});
