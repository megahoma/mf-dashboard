import assert from "node:assert/strict";
import test from "node:test";
import {
  appProbeId,
  createProbeBook,
  createProbeCycle,
  type Net,
} from "../src/entities/microfrontend/index.ts";
import { localApp } from "./support/app.ts";
const manifest = {
  metaData: { publicPath: "http://127.0.0.1:4100/", types: { zip: "types.zip" } },
};
const bytes = new Uint8Array([1, 2, 3]);
const input = {
  apps: [localApp("widget", "/widget")],
  links: [
    {
      consumer: "shell",
      alias: "widget",
      remoteName: "widget",
      url: "http://127.0.0.1:4100/mf-manifest.json",
    },
  ],
  extraManifestUrls: [],
};
test("a shared ZIP survives cycles and uses a conditional request", async () => {
  const book = createProbeBook();
  let bodies = 0;
  const net: Net = {
    connect: async () => true,
    get: async (url, init) => {
      if (url.endsWith(".json"))
        return { ok: true, json: manifest, body: null, lastModified: null };
      if (init?.ifModifiedSince === 1000)
        return {
          ok: true,
          status: 304,
          notModified: true,
          json: null,
          body: null,
          lastModified: 1000,
        };
      bodies++;
      return { ok: true, json: null, body: bytes, lastModified: 1000 };
    },
  };
  await createProbeCycle(net, book).start(input);
  const hash = book.apps.get(appProbeId("widget"))?.zipHash;
  await createProbeCycle(net, book).start(input);
  assert.equal(bodies, 1);
  assert.equal(book.apps.get(appProbeId("widget"))?.zipHash, hash);
});

test("a changed archive replaces its fact, while missing Last-Modified downloads every cycle", async () => {
  const book = createProbeBook();
  let modified: number | null = 1000;
  let body = bytes;
  const headers: (number | undefined)[] = [];
  const net: Net = {
    connect: async () => true,
    get: async (url, init) => {
      if (url.endsWith(".json"))
        return { ok: true, json: manifest, body: null, lastModified: null };
      headers.push(init?.ifModifiedSince);
      return { ok: true, json: null, body, lastModified: modified };
    },
  };
  await createProbeCycle(net, book).start(input);
  const first = book.apps.get(appProbeId("widget"))?.zipHash;
  modified = 2000;
  body = new Uint8Array([4, 5]);
  await createProbeCycle(net, book).start(input);
  assert.notEqual(book.apps.get(appProbeId("widget"))?.zipHash, first);
  modified = null;
  await createProbeCycle(net, book).start(input);
  await createProbeCycle(net, book).start(input);
  assert.deepEqual(headers, [undefined, 1000, 2000, undefined]);
});

test("an unsolicited 304 never invents a hash and unused zip facts are pruned", async () => {
  const book = createProbeBook();
  const net: Net = {
    connect: async () => true,
    get: async (url) =>
      url.endsWith(".json")
        ? { ok: true, json: manifest, body: null, lastModified: null }
        : { ok: true, status: 304, notModified: true, json: null, body: null, lastModified: 1000 },
  };
  await createProbeCycle(net, book).start(input);
  assert.equal(book.apps.get(appProbeId("widget"))?.zipHash, null);
  assert.equal(book.zips.size, 0);
  book.zips.set("https://unused.example/types.zip", { zipHash: "old", zipMtime: 1000 });
  await createProbeCycle(net, book).start({ apps: [], links: [], extraManifestUrls: [] });
  assert.equal(book.zips.size, 0);
});

test("loopback transport sends the HTTP date and ignores a 304 response body", async (t) => {
  const { createLoopbackNet } = await import("../src/entities/microfrontend/net.ts");
  let reads = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    assert.equal(
      new Headers(init?.headers).get("If-Modified-Since"),
      "Thu, 01 Jan 1970 00:00:01 GMT",
    );
    return {
      status: 304,
      ok: false,
      headers: new Headers(),
      arrayBuffer: async () => {
        reads++;
        throw new Error("unexpected body");
      },
      body: null,
    } as unknown as Response;
  });
  const response = await createLoopbackNet().get("https://example.com/types.zip", {
    ifModifiedSince: 1000,
  });
  assert.equal(response.notModified, true);
  assert.equal(response.body, null);
  assert.equal(reads, 0);
});
