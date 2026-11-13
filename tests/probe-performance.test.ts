import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import {
  appProbeId,
  createProbeBook,
  externalManifestId,
  linkProbeId,
  putLinkResult,
} from "../src/entities/microfrontend/lib/probe-book.ts";
import { createProbeCycle } from "../src/entities/microfrontend/lib/probe.ts";
import type {
  LinkProbeResult,
  Net,
  RemoteLink,
} from "../src/entities/microfrontend/models/probe.ts";
import { localApp } from "./support/app.ts";
import { createLogger } from "../src/shared/lib/logging.ts";

const manifestUrl = "http://127.0.0.1:4100/mf-manifest.json";
const bytes = new Uint8Array([1, 2, 3]);
const manifest = {
  metaData: {
    publicPath: "auto",
    buildInfo: { buildVersion: "build-1" },
    types: { zip: "types.zip" },
  },
  exposes: { "./Panel": {} },
  shared: { react: { version: "19", singleton: true } },
};

function link(alias: string, url = manifestUrl, remoteName = alias): RemoteLink {
  return { consumer: "shell", alias, remoteName, url };
}

function response(url: string): Awaited<ReturnType<Net["get"]>> {
  return {
    ok: true,
    json: url.endsWith(".zip") ? null : manifest,
    body: url.endsWith(".zip") ? bytes : null,
    lastModified: 1000,
  };
}

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("a ten-second manifest timeout identifies the slow URL at Info without credentials", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const messages: string[] = [];
  const log = createLogger({
    enabled: (level) => ["info", "warn", "error"].includes(level),
    write: (level, text) => messages.push(`${level} ${text}`),
  });
  const running = createProbeCycle(
    {
      connect: async () => false,
      get: () => new Promise(() => {}),
    },
    createProbeBook(),
  ).start({
    apps: [],
    links: [],
    extraManifestUrls: ["https://user:password@example.com/manifest.json?token=secret"],
    log,
  });
  await setImmediate();
  now = 10_000;
  t.mock.timers.tick(10_000);
  await running;
  assert.ok(
    messages.some((text) =>
      /^warn manifest.failed .*url=https:\/\/example.com\/manifest.json reason=timeout.*durationMs=10000/.test(
        text,
      ),
    ),
    messages.join("\n"),
  );
  assert.ok(messages.some((text) => /^warn probe.completed .*durationMs=10000/.test(text)));
  assert.doesNotMatch(messages.join("\n"), /user|password|token|secret/);
});

test("bulk link publication scans the book once and preserves standalone replacement semantics", async () => {
  const book = createProbeBook();
  const oldArtifact = {
    manifestReachable: true,
    buildVersion: "previous",
    zipUrl: null,
    zipMtime: null,
    zipHash: null,
    exposes: [],
    shared: [],
  };
  const next = Array.from({ length: 2000 }, (_, i) => link(`edge-${i}`));
  const old = next.map((edge, i) => ({
    ...edge,
    url: i === 1 ? manifestUrl : "https://example.com/previous.json",
  }));
  for (const edge of old) book.links.set(linkProbeId(edge), { link: edge, ...oldArtifact });
  const unrelated = { link: link("unrelated"), ...oldArtifact };
  book.links.set(linkProbeId(unrelated.link), unrelated);
  const previousEntries = [...book.links];
  const entries = book.links.entries.bind(book.links);
  let visited = 0;
  book.links[Symbol.iterator] = function* (): Generator<[string, LinkProbeResult], undefined> {
    for (const entry of entries()) {
      visited++;
      yield entry;
    }
    return undefined;
  };
  const intermediate = { ...next[0], url: "https://example.com/intermediate.json" };
  const input = [...next, intermediate, next[0]];
  await createProbeCycle(
    { connect: async () => false, get: async (url) => response(url) },
    book,
  ).start({ apps: [], links: input, extraManifestUrls: [], checkTypes: false });
  assert.ok(visited <= previousEntries.length, "publication must not scan the book per row");
  assert.equal(book.links.size, next.length + 1);
  assert.equal(book.links.get(linkProbeId(unrelated.link)), unrelated);
  assert.equal(book.links.has(linkProbeId(intermediate)), false);
  for (const edge of old)
    if (edge.url !== manifestUrl) assert.equal(book.links.has(linkProbeId(edge)), false);

  const updated = book.links.get(linkProbeId(next[0]))!;
  assert.equal(updated.buildVersion, "build-1");
  const standalone = createProbeBook();
  // A small equivalent sequence checks retained IDs, unrelated entries and duplicate edge ordering.
  for (const [id, result] of previousEntries.filter(([, result]) =>
    ["edge-0", "edge-1", "unrelated"].includes(result.link.alias),
  ))
    standalone.links.set(id, result);
  for (const edge of [next[0], next[1], intermediate, next[0]])
    putLinkResult(standalone, { ...updated, link: edge });
  const relevant = [...book.links.entries()].filter(([, result]) =>
    ["edge-0", "edge-1", "unrelated"].includes(result.link.alias),
  );
  assert.deepEqual(relevant, [...standalone.links]);
});

test("apps, links and extras share one manifest while scoped rows enrich types independently", async () => {
  const unchecked = link("unchecked");
  const checked = link("checked");
  const requests: string[] = [];
  const book = createProbeBook();
  await createProbeCycle(
    {
      connect: async () => true,
      get: async (url) => {
        requests.push(url);
        return response(url);
      },
    },
    book,
  ).start({
    apps: [localApp("local", "/local")],
    links: [unchecked, checked],
    extraManifestUrls: [manifestUrl, manifestUrl],
    typeLinks: new Set([linkProbeId(checked)]),
  });
  assert.deepEqual(requests, [manifestUrl, "http://127.0.0.1:4100/types.zip"]);
  const typed = book.links.get(linkProbeId(checked));
  assert.ok(typed?.zipHash);
  for (const result of [
    book.apps.get(appProbeId("local")),
    book.links.get(linkProbeId(unchecked)),
    book.extras.get(externalManifestId(manifestUrl)),
  ]) {
    assert.equal(result?.zipHash, null);
    assert.equal(result?.buildVersion, "build-1");
    assert.deepEqual(result?.exposes, ["./Panel"]);
    assert.deepEqual(result?.shared, [{ name: "react", version: "19", singleton: true }]);
  }
});

test("distinct manifests share an in-flight ZIP and retain its conditional cache next cycle", async () => {
  const download = gate();
  const requests: (number | undefined)[] = [];
  const urls = Array.from({ length: 12 }, (_, i) => `https://example.com/${i}.json`);
  const book = createProbeBook();
  const cycle = createProbeCycle(
    {
      connect: async () => false,
      get: async (url, init) => {
        if (url.endsWith(".zip")) {
          requests.push(init?.ifModifiedSince);
          await download.promise;
          return init?.ifModifiedSince === 1000
            ? { ok: false, status: 304, json: null, body: null, lastModified: null }
            : response(url);
        }
        return {
          ...response(url),
          json: {
            metaData: { publicPath: "https://example.com/", types: { zip: "shared.zip" } },
          },
        };
      },
    },
    book,
  );
  const input = { apps: [], links: [], extraManifestUrls: urls };
  const running = cycle.start(input);
  try {
    await setImmediate();
    assert.deepEqual(requests, [undefined]);
  } finally {
    download.release();
    await running;
  }
  const hashes = new Set([...book.extras.values()].map((result) => result.zipHash));
  assert.equal(hashes.size, 1);
  assert.ok([...hashes][0]);
  await cycle.start(input);
  assert.deepEqual(requests, [undefined, 1000]);
  assert.deepEqual(new Set([...book.extras.values()].map((result) => result.zipHash)), hashes);
});

test("app connections and unique manifest requests run concurrently within one shared bound", async () => {
  const blocked = gate();
  let active = 0;
  let peak = 0;
  let connections = 0;
  let manifests = 0;
  async function wait() {
    active++;
    peak = Math.max(peak, active);
    try {
      await blocked.promise;
    } finally {
      active--;
    }
  }
  const apps = Array.from({ length: 20 }, (_, i) =>
    localApp(`app-${i}`, `/app-${i}`, { port: 4200 + i, manifest: false }),
  );
  const urls = Array.from({ length: 20 }, (_, i) => `https://example.com/${i}.json`);
  const book = createProbeBook();
  const running = createProbeCycle(
    {
      connect: async () => {
        connections++;
        await wait();
        return true;
      },
      get: async (url) => {
        manifests++;
        await wait();
        return response(url);
      },
    },
    book,
  ).start({
    apps,
    links: urls.map((url, i) => link(`edge-${i}`, url)),
    extraManifestUrls: urls,
    checkTypes: false,
  });
  try {
    await setImmediate();
    assert.ok(active > 1, "independent probes should overlap");
    assert.ok(active <= 8, "queued work must not start unlimited network operations");
  } finally {
    blocked.release();
    await running;
  }
  assert.ok(peak <= 8);
  assert.equal(connections, apps.length);
  assert.equal(manifests, urls.length);
  assert.equal(book.apps.size, apps.length);
  assert.equal(book.links.size, urls.length);
});

test("queued requests get their full timeout after concurrent requests finish", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let started = 0;
  let finished = false;
  const book = createProbeBook();
  const running = createProbeCycle(
    {
      connect: async () => false,
      get: () => {
        started++;
        return new Promise(() => {});
      },
    },
    book,
  )
    .start({
      apps: [],
      links: [],
      extraManifestUrls: Array.from({ length: 10 }, (_, i) => `https://example.com/${i}.json`),
    })
    .then(() => {
      finished = true;
    });
  await setImmediate();
  assert.equal(started, 8);
  t.mock.timers.tick(10_000);
  await setImmediate();
  assert.equal(started, 10);
  assert.equal(finished, false, "queued requests must not time out before starting");
  t.mock.timers.tick(10_000);
  await running;
  assert.equal(book.extras.size, 10);
  assert.ok([...book.extras.values()].every((result) => result.requestFailure === "timeout"));
});

test("scoped type checks still collect producer dependencies without checking unrelated rows", async () => {
  const producerUrl = "http://127.0.0.1:4300/mf-manifest.json";
  const dependencyUrl = "http://127.0.0.1:4301/mf-manifest.json";
  const unrelatedUrl = "http://127.0.0.1:4302/mf-manifest.json";
  const selected = link("producer", producerUrl, "producer");
  const unselected = link("dependency", dependencyUrl, "dependency");
  const book = createProbeBook();
  const requests: string[] = [];
  await createProbeCycle(
    {
      connect: async () => true,
      get: async (url) => {
        requests.push(url);
        return response(url);
      },
    },
    book,
  ).start({
    apps: [
      localApp("producer", "/producer", {
        port: 4300,
        remotes: [{ alias: "dependency", name: "dependency", url: dependencyUrl }],
      }),
      localApp("dependency", "/dependency", { port: 4301 }),
      localApp("unrelated", "/unrelated", { port: 4302 }),
    ],
    links: [selected, unselected],
    extraManifestUrls: [dependencyUrl, unrelatedUrl],
    typeLinks: new Set([linkProbeId(selected)]),
  });
  assert.equal(requests.filter((url) => url.endsWith(".json")).length, 3);
  assert.deepEqual(requests.filter((url) => url.endsWith(".zip")).sort(), [
    "http://127.0.0.1:4300/types.zip",
    "http://127.0.0.1:4301/types.zip",
  ]);
  assert.ok(book.apps.get(appProbeId("producer"))?.zipHash);
  assert.ok(book.apps.get(appProbeId("dependency"))?.zipHash);
  assert.equal(book.apps.get(appProbeId("unrelated"))?.zipHash, null);
  assert.equal(book.links.get(linkProbeId(unselected))?.zipHash, null);
  assert.ok([...book.extras.values()].every((result) => result.zipHash == null));
});

test("checkTypes false shares manifest metadata without downloading or pruning ZIP facts", async () => {
  const book = createProbeBook();
  book.zips.set("https://example.com/old.zip", { zipHash: "prior-hash", zipMtime: 1000 });
  const requests: string[] = [];
  await createProbeCycle(
    {
      connect: async () => true,
      get: async (url) => {
        requests.push(url);
        assert.ok(!url.endsWith(".zip"));
        return response(url);
      },
    },
    book,
  ).start({
    apps: [localApp("local", "/local")],
    links: [link("remote")],
    extraManifestUrls: [manifestUrl],
    checkTypes: false,
  });
  assert.deepEqual(requests, [manifestUrl]);
  assert.equal(book.zips.size, 1);
  assert.deepEqual(book.apps.get(appProbeId("local"))?.exposes, ["./Panel"]);
  assert.equal(book.apps.get(appProbeId("local"))?.zipHash, null);
});

for (const failure of ["network", "http"] as const) {
  test(`a shared ${failure} manifest failure is isolated to its endpoint and retried next cycle`, async () => {
    const other = "https://example.com/healthy.json";
    let broken = true;
    const requests: string[] = [];
    const book = createProbeBook();
    const cycle = createProbeCycle(
      {
        connect: async () => true,
        get: async (url) => {
          requests.push(url);
          if (url === manifestUrl && broken) {
            if (failure === "network") throw new Error("offline");
            return { ok: false, status: 503, json: null, body: null, lastModified: null };
          }
          return response(url);
        },
      },
      book,
    );
    const input = {
      apps: [localApp("local", "/local")],
      links: [link("remote")],
      extraManifestUrls: [manifestUrl, other],
      checkTypes: false,
    };
    await cycle.start(input);
    assert.equal(requests.filter((url) => url === manifestUrl).length, 1);
    assert.equal(
      book.apps.get(appProbeId("local"))?.requestFailure,
      failure === "network" ? "network" : "HTTP 503",
    );
    assert.equal(book.extras.get(externalManifestId(other))?.manifestReachable, true);
    broken = false;
    await cycle.start(input);
    assert.equal(requests.filter((url) => url === manifestUrl).length, 2);
    assert.equal(book.apps.get(appProbeId("local"))?.manifestReachable, true);
    assert.equal(book.extras.get(externalManifestId(manifestUrl))?.requestFailure, undefined);
  });
}
