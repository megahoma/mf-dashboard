import assert from "node:assert/strict";
import test from "node:test";
import {
  appProbeId,
  createProbeBook,
  createProbeCycle,
  externalManifestId,
  httpDateMs,
  probeApp,
  probeLink,
  putAppResult,
} from "../src/entities/microfrontend/index.ts";
import type { LocalApp, RemoteLink } from "../src/entities/microfrontend/index.ts";
import { createLoopbackNet } from "../src/widgets/mf-dashboard-tree/net.ts";

const app: LocalApp = {
  name: "app",
  folder: "/widget-1",
  configFile: "/widget-1/rsbuild.config.ts",
  port: 4100,
  manifest: true,
  generateTypes: true,
  consumeTypes: true,
  typesFolder: "@mf-types",
  tsconfig: "./tsconfig.json",
  manifestPath: "/mf-manifest.json",
  compilerInstance: null,
  remotes: [],
};

test("open port and manifest json yield buildVersion", async () => {
  const net = {
    connect: async () => true,
    get: async () => ({
      ok: true,
      json: { metaData: { buildInfo: { buildVersion: "1.0.0" } } },
      body: null,
      lastModified: null,
    }),
  };
  const result = await probeApp({ ...app, manifest: true, port: 4100 }, net);
  assert.equal(result.portOpen, true);
  assert.equal(result.buildVersion, "1.0.0");
});

test("a reached manifest keeps exposes and shared on the link probe", async () => {
  const result = await probeLink(link("http://127.0.0.1:4100/mf-manifest.json"), {
    connect: async () => true,
    get: async () => ({
      ok: true,
      json: {
        exposes: [{ path: "./Button", name: "Button" }, { name: "Header" }],
        shared: [{ name: "react", version: "18.2.0", singleton: true, requiredVersion: "^18" }],
      },
      body: null,
      lastModified: null,
    }),
  });
  assert.deepEqual(result.exposes, ["./Button", "Header"]);
  assert.deepEqual(result.shared, [{ name: "react", version: "18.2.0", singleton: true }]);
});

test("manifest disabled does not call get", async () => {
  let called = false;
  const net = {
    connect: async () => true,
    get: async () => {
      called = true;
      return { ok: false, json: null, body: null, lastModified: null };
    },
  };
  const result = await probeApp({ ...app, manifest: false, remotes: [] }, net);
  assert.equal(result.buildVersion, null);
  assert.equal(called, false);
});

const OLD_ZIP = new TextEncoder().encode("old-zip");
const NEW_ZIP = new TextEncoder().encode("new-zip");
const OLD_ZIP_HASH = "3e4212e250f6044ba532e632feb0ff4c302d8478aaa639bbd1e347ee2e9cff7f";
const NEW_ZIP_HASH = "1e8550cf1915a462a21c8bce406adb8949fe3ee4a5cb4f807a525c7e33b1f57c";
const HTTP_DATE = "Sun, 06 Nov 1994 08:49:37 GMT";
const HTTP_DATE_MS = 784111777000;

function manifestJson(version: string, meta: Record<string, unknown>) {
  return { metaData: { buildInfo: { buildVersion: version }, ...meta } };
}

test("a closed port does not request the manifest", async () => {
  let gets = 0;
  const net = {
    connect: async () => false,
    get: async () => {
      gets += 1;
      return { ok: true, json: manifestJson("1.0.0", {}), body: null, lastModified: null };
    },
  };
  const result = await probeApp(app, net);
  assert.equal(result.portOpen, false);
  assert.equal(result.buildVersion, null);
  assert.equal(gets, 0);
});

test("the local manifest url is 127.0.0.1 plus manifestPath", async () => {
  const urls: string[] = [];
  const net = {
    connect: async (port: number) => port === 4500,
    get: async (url: string) => {
      urls.push(url);
      return {
        ok: true,
        json: manifestJson("1.4.0", { publicPath: "auto", types: { zip: "" } }),
        body: null,
        lastModified: null,
      };
    },
  };
  const result = await probeApp({ ...app, port: 4500, manifestPath: "/static/manifest.json" }, net);
  assert.deepEqual(urls, ["http://127.0.0.1:4500/static/manifest.json"]);
  assert.equal(result.buildVersion, "1.4.0");
  assert.equal(result.zipUrl, null);
});

test("only a real http date becomes zipMtime", () => {
  assert.equal(httpDateMs(HTTP_DATE), HTTP_DATE_MS);
  assert.equal(httpDateMs("Sunday, 06-Nov-94 08:49:37 GMT"), HTTP_DATE_MS);
  assert.equal(httpDateMs("Sun Nov  6 08:49:37 1994"), HTTP_DATE_MS);
  assert.equal(httpDateMs("Sun, 31 Feb 1994 08:49:37 GMT"), null);
  assert.equal(httpDateMs("not-a-date"), null);
  assert.equal(httpDateMs("0"), null);
  assert.equal(httpDateMs(""), null);
  assert.equal(httpDateMs(null), null);
});

test("the first poll of an old zip without Last-Modified leaves zipMtime null", async () => {
  const urls: string[] = [];
  const net = {
    connect: async () => true,
    get: async (url: string) => {
      urls.push(url);
      if (url.endsWith("/@mf-types.zip"))
        return { ok: true, json: null, body: OLD_ZIP, lastModified: null };
      return {
        ok: true,
        json: manifestJson("1.0.0", { publicPath: "auto", types: { zip: "@mf-types.zip" } }),
        body: null,
        lastModified: 1_700_000_000_000,
      };
    },
  };
  const result = await probeApp(app, net);
  assert.deepEqual(urls, [
    "http://127.0.0.1:4100/mf-manifest.json",
    "http://127.0.0.1:4100/@mf-types.zip",
  ]);
  assert.equal(result.zipUrl, "http://127.0.0.1:4100/@mf-types.zip");
  assert.equal(result.zipHash, OLD_ZIP_HASH);
  assert.equal(result.zipMtime, null);
});

test("a repeat poll of the same zip still has no zipMtime", async () => {
  const net = zipNet(() => OLD_ZIP, null);
  const first = await probeApp(app, net);
  const second = await probeApp(app, net);
  assert.equal(first.zipHash, OLD_ZIP_HASH);
  assert.equal(second.zipHash, OLD_ZIP_HASH);
  assert.equal(first.zipMtime, null);
  assert.equal(second.zipMtime, null);
});

test("a hash change still does not invent zipMtime", async () => {
  let body = OLD_ZIP;
  const net = zipNet(() => body, null);
  const first = await probeApp(app, net);
  body = NEW_ZIP;
  const second = await probeApp(app, net);
  assert.equal(first.zipHash, OLD_ZIP_HASH);
  assert.equal(second.zipHash, NEW_ZIP_HASH);
  assert.equal(second.zipMtime, null);
});

test("a restart does not turn the first poll into zipMtime", async () => {
  const net = zipNet(() => OLD_ZIP, null);
  const book = createProbeBook();
  putAppResult(book, app.name, await probeApp(app, net));
  const restarted = createProbeBook();
  putAppResult(restarted, app.name, await probeApp(app, net));
  assert.equal(book.apps.get(appProbeId(app.name))?.zipMtime, null);
  assert.equal(restarted.apps.get(appProbeId(app.name))?.zipHash, OLD_ZIP_HASH);
  assert.equal(restarted.apps.get(appProbeId(app.name))?.zipMtime, null);
  assert.equal(book.links.size, 0);
});

test("a real Last-Modified on the zip is zipMtime", async () => {
  const net = zipNet(() => OLD_ZIP, httpDateMs(HTTP_DATE));
  const result = await probeApp(app, net);
  assert.equal(result.zipMtime, HTTP_DATE_MS);
  assert.notEqual(result.zipMtime, Date.now());
});

test("an absolute publicPath and auto both resolve an http zip url", async () => {
  const absolute = await probeLink(
    link("http://127.0.0.1:18080/mf-manifest.json"),
    manifestNet({
      publicPath: "http://127.0.0.1:18080/",
      types: { zip: "@mf-types.zip" },
    }),
  );
  assert.equal(absolute.zipUrl, "http://127.0.0.1:18080/@mf-types.zip");
  const automatic = await probeLink(
    link("http://127.0.0.1:18081/mf-manifest.json?cache=1#top"),
    manifestNet({
      publicPath: "auto",
      types: { zip: "@mf-types.zip" },
    }),
  );
  assert.equal(automatic.zipUrl, "http://127.0.0.1:18081/@mf-types.zip");
});

test("a non-http manifest url is not requested", async () => {
  let gets = 0;
  const net = {
    connect: async () => {
      throw new Error("connect is not used for a link");
    },
    get: async () => {
      gets += 1;
      return { ok: true, json: manifestJson("1", {}), body: null, lastModified: null };
    },
  };
  for (const url of [
    null,
    "",
    "   ",
    "file:///tmp/mf-manifest.json",
    "http://${HOST}/mf-manifest.json",
    "javascript:alert(1)",
  ]) {
    const result = await probeLink(link(url), net);
    assert.equal(result.manifestReachable, false);
    assert.equal(result.zipUrl, null);
    assert.equal(result.buildVersion, null);
  }
  assert.equal(gets, 0);
});

test("a resolved zip url that is not http is not requested", async () => {
  const urls: string[] = [];
  const result = await probeLink(link("http://127.0.0.1:4100/mf-manifest.json"), {
    connect: async () => true,
    get: async (url: string) => {
      urls.push(url);
      return {
        ok: true,
        json: manifestJson("1", {
          publicPath: "file:///tmp/dist",
          types: { zip: "@mf-types.zip" },
        }),
        body: OLD_ZIP,
        lastModified: HTTP_DATE_MS,
      };
    },
  });
  assert.deepEqual(urls, ["http://127.0.0.1:4100/mf-manifest.json"]);
  assert.equal(result.manifestReachable, true);
  assert.equal(result.zipUrl, null);
  assert.equal(result.zipHash, null);
  assert.equal(result.zipMtime, null);
});

test("a manifest request times out", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let gets = 0;
  const net = {
    connect: async () => true,
    get: () => {
      gets += 1;
      return new Promise<{ ok: boolean; json: null; body: null; lastModified: null }>(() => {});
    },
  };
  const pending = probeApp(app, net);
  for (let turn = 0; turn < 8 && gets === 0; turn += 1) await Promise.resolve();
  assert.equal(gets, 1);
  t.mock.timers.tick(9_999);
  let early = false;
  pending.then(() => {
    early = true;
  });
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
  assert.equal(early, false);
  t.mock.timers.tick(1);
  const result = await pending;
  assert.equal(result.portOpen, true);
  assert.equal(result.manifestReachable, false);
  assert.equal(result.requestFailure, "timeout");
  assert.equal(result.buildVersion, null);
  assert.equal(result.zipMtime, null);
});

test("failed manifest requests retain HTTP, network and fetch timeout reasons", async () => {
  const target = link("https://cdn.example/mf-manifest.json");
  for (const status of [404, 503]) {
    const result = await probeLink(target, {
      connect: async () => true,
      get: async () => ({ ok: false, status, json: null, body: null, lastModified: null }),
    });
    assert.equal(result.manifestReachable, false);
    assert.equal(result.requestFailure, `HTTP ${status}`);
  }
  for (const [error, reason] of [
    [new TypeError("fetch failed"), "network"],
    [new DOMException("The operation was aborted due to timeout", "TimeoutError"), "timeout"],
  ] as const) {
    const result = await probeLink(target, {
      connect: async () => true,
      get: async () => {
        throw error;
      },
    });
    assert.equal(result.requestFailure, reason);
  }
  const recovered = await probeLink(target, versionNet("1", "auto"));
  assert.equal(recovered.manifestReachable, true);
  assert.equal(recovered.requestFailure, undefined);
});

test("HTTP adapter retains the response status", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
  const result = await createLoopbackNet().get("https://cdn.example/mf-manifest.json");
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
});

test("a probe cycle does not start while the previous one is still running", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let connects = 0;
  const net = {
    connect: async () => {
      connects += 1;
      await gate;
      return true;
    },
    get: async () => ({ ok: false, json: null, body: null, lastModified: null }),
  };
  const book = createProbeBook();
  const cycle = createProbeCycle(net, book);
  const pending = link("http://127.0.0.1:4400/mf-manifest.json");
  const first = cycle.start({
    apps: [{ ...app, manifest: false }],
    links: [],
    extraManifestUrls: [],
  });
  const second = await cycle.start({
    apps: [{ ...app, manifest: false, port: 3999 }],
    links: [pending],
    extraManifestUrls: ["https://other.example/mf-manifest.json"],
  });
  assert.equal(second, false);
  assert.equal(connects, 1);
  assert.equal(book.apps.size, 0);
  assert.equal(book.links.size, 0);
  assert.equal(book.extras.size, 0);
  release();
  assert.equal(await first, true);
  assert.equal(book.apps.get(appProbeId(app.name))?.portOpen, true);
  const third = await cycle.start({
    apps: [],
    links: [pending],
    extraManifestUrls: ["https://cdn.example/mf-manifest.json"],
  });
  assert.equal(third, true);
  assert.equal(connects, 1);
  assert.equal(book.links.size, 1);
  assert.equal(
    book.extras.get(externalManifestId("https://cdn.example/mf-manifest.json"))?.manifestReachable,
    false,
  );
  assert.equal(book.links.has(externalManifestId("https://cdn.example/mf-manifest.json")), false);
  assert.equal(book.apps.size, 1);
});

function link(url: string | null): RemoteLink {
  return { consumer: "app", alias: "dep", remoteName: "dep", url };
}

function manifestNet(meta: Record<string, unknown>) {
  return {
    connect: async () => false,
    get: async (url: string) => {
      if (url.endsWith(".zip")) return { ok: true, json: null, body: OLD_ZIP, lastModified: null };
      return { ok: true, json: manifestJson("1", meta), body: null, lastModified: null };
    },
  };
}

function versionNet(version: string, publicPath: string) {
  return {
    connect: async () => false,
    get: async (url: string) => {
      if (url.endsWith(".zip")) return { ok: true, json: null, body: OLD_ZIP, lastModified: null };
      return {
        ok: true,
        json: manifestJson(version, { publicPath, types: { zip: "@mf-types.zip" } }),
        body: null,
        lastModified: null,
      };
    },
  };
}

function zipNet(body: () => Uint8Array, lastModified: number | null) {
  return {
    connect: async () => true,
    get: async (url: string) => {
      if (url.endsWith("/@mf-types.zip"))
        return { ok: true, json: null, body: body(), lastModified };
      return {
        ok: true,
        json: manifestJson("1.0.0", { publicPath: "auto", types: { zip: "@mf-types.zip" } }),
        body: null,
        lastModified: 1_700_000_000_000,
      };
    },
  };
}
