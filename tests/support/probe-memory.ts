import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createProbeCycle, createProbeBook } from "../../src/entities/microfrontend/probe.ts";

const archives: WeakRef<Uint8Array>[] = [];
let reached: () => void = () => {};
let release: () => void = () => {};
const blocked = new Promise<void>((resolve) => {
  release = resolve;
});
const waiting = new Promise<void>((resolve) => {
  reached = resolve;
});
const cycle = createProbeCycle(
  {
    connect: async () => false,
    get: async (url) => {
      if (url.endsWith("sentinel.json")) {
        reached();
        await blocked;
        return { ok: false, json: null, body: null, lastModified: null };
      }
      if (url.endsWith(".zip")) {
        const body = new Uint8Array(1024 * 1024);
        archives.push(new WeakRef(body));
        return { ok: true, json: null, body, lastModified: null };
      }
      return {
        ok: true,
        json: { metaData: { publicPath: "auto", types: { zip: "types.zip" } } },
        body: null,
        lastModified: null,
      };
    },
  },
  createProbeBook(),
);
const run = cycle.start({
  apps: [],
  links: [],
  extraManifestUrls: [
    ...Array.from({ length: 12 }, (_, i) => `https://example.com/${i}/mf-manifest.json`),
    "https://example.com/sentinel.json",
  ],
});
await waiting;
try {
  assert.equal(archives.length, 12);
  assert.ok(global.gc, "run this fixture with --expose-gc");
  await setImmediate();
  global.gc();
  await setImmediate();
  global.gc();
  assert.equal(archives.filter((archive) => archive.deref() != null).length, 0);
} finally {
  release();
  await run;
}
