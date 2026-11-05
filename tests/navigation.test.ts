import { createLogger } from "../src/shared/logging.ts";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { localApp } from "./support/app.ts";
import net from "node:net";
import { EventEmitter } from "node:events";
import { createConfirmationStore } from "../src/entities/federated-types/index.ts";
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

test("refresh recognizes external watch output and keeps offline type changes visible", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-watch-refresh-"));
  const consumer = path.join(root, "workshop");
  const producer = path.join(root, "palette");
  const destination = path.join(consumer, "@mf-types", "paint");
  const sdk = path.join(consumer, "node_modules", "adm-zip");
  for (const folder of [consumer, producer, destination, sdk])
    fs.mkdirSync(folder, { recursive: true });
  let text = "export type Pigment = 'blue';";
  let online = true;
  let downloads = 0;
  fs.writeFileSync(path.join(consumer, "package.json"), "{}");
  fs.writeFileSync(
    path.join(consumer, "rsbuild.config.ts"),
    `export default defineConfig({server:{port:4400},plugins:[pluginModuleFederation({name:'workshop',dts:true,remotes:{paint:'palette@http://localhost:4401/mf-manifest.json'}})]});`,
  );
  fs.writeFileSync(
    path.join(producer, "rsbuild.config.ts"),
    `export default defineConfig({server:{port:4401},plugins:[pluginModuleFederation({name:'palette',dts:true,manifest:true})]});`,
  );
  fs.writeFileSync(path.join(destination, "index.d.ts"), text);
  fs.writeFileSync(
    path.join(sdk, "index.js"),
    `const fs=require('node:fs'),path=require('node:path');
    module.exports=class {
      constructor(blob){this.items=JSON.parse(blob.subarray(4).toString());}
      getEntries(){return this.items.map(item=>({entryName:item.file,isDirectory:false}));}
      extractAllTo(folder){for(const item of this.items)fs.writeFileSync(path.join(folder,item.file),item.text);}
    };`,
  );
  Object.assign(vscode.workspace, {
    workspaceFolders: [{ name: "sample", uri: vscode.Uri.file(root) }],
  });
  t.after(() => {
    Reflect.deleteProperty(vscode.workspace, "workspaceFolders");
    fs.rmSync(root, { recursive: true, force: true });
  });
  t.mock.method(vscode.workspace, "getConfiguration", () => ({
    async update() {},
    inspect: () => ({
      workspaceValue: { workshop: { path: "workshop" }, palette: { path: "palette" } },
    }),
    get: <T>(key: string): T | undefined =>
      (key === "structure" ? "tree" : undefined) as T | undefined,
  }));
  t.mock.method(net, "connect", () => {
    const socket = Object.assign(new EventEmitter(), { setTimeout() {}, destroy() {} });
    queueMicrotask(() => socket.emit(online ? "connect" : "error", new Error("offline")));
    return socket as unknown as net.Socket;
  });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    if (!online) throw new Error("offline");
    if (String(input).endsWith(".json"))
      return Response.json({
        metaData: { publicPath: "http://localhost:4401/", types: { zip: "types.zip" } },
      });
    downloads++;
    const bytes = Buffer.concat([
      Buffer.from([0x50, 0x4b, 3, 4]),
      Buffer.from(JSON.stringify([{ file: "index.d.ts", text }])),
    ]);
    return new Response(bytes, {
      headers: { "last-modified": new Date(Date.now() + 60_000).toUTCString() },
    });
  });
  const store = createConfirmationStore();
  let persisted = 0;
  const provider = new MfDashboardProvider(
    () => terms,
    store,
    () => {
      persisted++;
    },
  );
  t.after(() => provider.dispose());
  await provider.refresh();
  const row = () => provider.getChildren().find((node) => node.name === "workshop")!.children[0];
  const link = { consumer: "workshop", alias: "paint", remoteName: "palette" };
  const initial = store.install(link);
  assert.ok(initial);
  assert.equal(
    provider.session.typesForLink({ ...link, url: "http://localhost:4401/mf-manifest.json" }),
    "ok",
  );
  assert.equal(persisted, 1);
  await provider.refresh();
  assert.equal(downloads, 3, "one initial probe, one comparison, then only the next probe");
  text = "export type Pigment = 'violet';";
  fs.writeFileSync(path.join(destination, "index.d.ts"), text);
  await provider.refresh();
  assert.equal(persisted, 2);
  assert.notEqual(store.install(link)?.zipHash, initial.zipHash);
  assert.equal(row().kind, "listen");
  online = false;
  fs.writeFileSync(
    path.join(destination, "index.d.ts"),
    "export type Pigment = 'changed offline';",
  );
  await provider.refresh();
  assert.equal(row().kind, "silent");
  assert.ok(row().description.includes(`@mf-types: ${terms.typesChanged}`));
  assert.equal(persisted, 2);
});

test("stat failures in installed types do not prevent rendering the dashboard", (t) => {
  const producer = localApp("producer", "/producer", { generateTypes: false });
  const consumer = localApp("consumer", "/consumer", {
    consumeTypes: true,
    remotes: [{ alias: "producer", name: "producer", url: null }],
  });
  const provider = new MfDashboardProvider(() => terms);
  t.after(() => provider.dispose());
  provider.session.loaded = [consumer, producer, localApp("other", "/other")];
  for (const code of ["EACCES", "EIO", "ENOTDIR"]) {
    const stat = t.mock.method(fs, "statSync", () => {
      throw Object.assign(new Error(code), { code });
    });
    try {
      provider.session.beforeRefreshChange();
      const rows = provider.getChildren();
      assert.deepEqual(
        rows.map((row) => row.name),
        ["consumer", "other"],
      );
      assert.equal(rows[0].children[0].name, "producer");
      assert.equal(
        provider.session.typesForLink({
          consumer: "consumer",
          alias: "producer",
          remoteName: "producer",
          url: null,
        }),
        "manual",
      );
    } finally {
      stat.mock.restore();
    }
  }
});

test("shared producers are scanned once and invalidated with the link status cache", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mf-producer-cache-")));
  const producer = localApp("producer", root);
  const source = path.join(root, "app.ts");
  fs.writeFileSync(source, "export const app = 1;");
  const evidenceEvents: string[] = [];
  const provider = new MfDashboardProvider(
    () => terms,
    undefined,
    undefined,
    createLogger({
      enabled: () => true,
      write: (_level, text) => evidenceEvents.push(text),
    }),
  );
  t.after(() => {
    provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  provider.session.loaded = [
    producer,
    ...["a", "b"].map((name) =>
      localApp(name, `/${name}`, {
        consumeTypes: true,
        remotes: [
          { alias: "producer", name: "producer", url: "http://localhost:4100/mf-manifest.json" },
        ],
      }),
    ),
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
  assert.equal(count(), 2);
  fs.writeFileSync(source, "export const app = 3;");
  await provider.fileSaved(source);
  // fileSaved's notification observes both links; they share the new producer snapshot.
  provider.session.typesForLink(linkA);
  provider.session.typesForLink(linkB);
  assert.equal(count(), 2, "source saves keep byte reads off the extension host");
  const sourceScans = () =>
    evidenceEvents.filter((text) => text.includes("fingerprint.sources.") && text.includes(root))
      .length;
  const beforeSettle = sourceScans();
  const settled = new Promise<void>((resolve) => {
    const listener = provider.onDidChangeTreeData(() => {
      listener.dispose();
      resolve();
    });
  });
  t.mock.timers.tick(15_000);
  await settled;
  provider.session.typesForLink(linkA);
  provider.session.typesForLink(linkB);
  assert.equal(
    sourceScans(),
    beforeSettle + 1,
    "the settle timer refreshes the shared producer once",
  );
  assert.equal(count(), 2, "the settle check keeps source reads in the worker");
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

test("unchanged status and unreadable-type warnings stay quiet until recovery", (t) => {
  const events: { level: string; text: string }[] = [];
  const log = createLogger({
    enabled: () => true,
    write: (level, text) => events.push({ level, text }),
  });
  const provider = new MfDashboardProvider(() => terms, undefined, undefined, log);
  t.after(() => provider.dispose());
  provider.session.loaded = [
    localApp("consumer", "/consumer", {
      consumeTypes: true,
      remotes: [{ alias: "remote", name: "remote", url: null }],
    }),
    localApp("remote", "/remote", { generateTypes: false }),
  ];
  let broken = true;
  const original = fs.statSync;
  t.mock.method(fs, "statSync", (...args: Parameters<typeof fs.statSync>) => {
    if (broken && String(args[0]).includes("@mf-types"))
      throw Object.assign(new Error("SECRET"), { code: "EACCES" });
    return Reflect.apply(original, fs, args);
  });
  const render = () => {
    provider.session.beforeRefreshChange();
    provider.session.relabel(terms);
  };
  render();
  render();
  assert.equal(events.filter((event) => event.level === "warn").length, 1);
  assert.equal(events.filter((event) => event.text.startsWith("status.changed")).length, 2);
  broken = false;
  render();
  broken = true;
  render();
  assert.equal(events.filter((event) => event.level === "warn").length, 2);
  assert.equal(
    events.some((event) => event.text.includes("SECRET")),
    false,
  );
});

test("a malformed producer tsconfig leaves the rest of the tree visible with unknown type evidence", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-bad-tsconfig-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "tsconfig.json"), '{"include":broken}');
  const provider = new MfDashboardProvider(() => terms);
  t.after(() => provider.dispose());
  provider.session.loaded = [
    localApp("consumer", root, {
      consumeTypes: true,
      remotes: [{ alias: "producer", name: "producer", url: null }],
    }),
    localApp("producer", root),
    localApp("other", root),
  ];
  const rows = provider.getChildren();
  assert.deepEqual(
    rows.map((row) => row.name),
    ["consumer", "other"],
  );
  assert.equal(rows[0].children[0].name, "producer");
  assert.equal(
    provider.session.typesForLink({
      consumer: "consumer",
      alias: "producer",
      remoteName: "producer",
      url: null,
    }),
    "unknown",
  );
});
