import assert from "node:assert/strict";
import test from "node:test";
import { terms } from "../src/shared/config/index.ts";
import { localApp } from "./support/app.ts";
import {
  createProbeBook,
  putAppResult,
  type LocalApp,
} from "../src/entities/microfrontend/index.ts";
import { DashboardSession } from "../src/widgets/mf-dashboard-tree/models/session.ts";
import type { DashboardNode } from "../src/widgets/mf-dashboard-tree/models/presentation.ts";

function app(name: string, remotes: string[] = []): LocalApp {
  return localApp(name, `/workspace/${name}`, {
    consumeTypes: true,
    remotes: remotes.map((name, index) => ({
      alias: `dependency-${index}`,
      name,
      url: `http://localhost:4100/${name}/mf-manifest.json`,
    })),
  });
}

function sessionFor(apps: LocalApp[]): DashboardSession {
  const session = new DashboardSession(
    {
      readSettings: () => ({
        apps: {},
        envMode: "development",
        ignorePaths: [],
        extraManifestUrls: [],
        structure: "tree",
      }),
      writeApps() {},
      scan: () => ({}),
      loadKnown: () => apps,
      async probe() {},
      roots: () => [],
    },
    createProbeBook(),
  );
  session.loaded = apps;
  return session;
}

function rows(nodes: DashboardNode[]): DashboardNode[] {
  const result: DashboardNode[] = [];
  const pending = [...nodes];
  while (pending.length) {
    const node = pending.pop()!;
    result.push(node);
    pending.push(...node.children);
  }
  return result;
}

test("diamonds keep every edge and reference rows retain consumer actions and type status", () => {
  const session = sessionFor([
    app("entry", ["left", "right"]),
    app("left", ["shared"]),
    app("right", ["shared"]),
    app("shared", ["leaf"]),
    app("leaf"),
  ]);
  session.typesForLink = (link) => (link.consumer === "right" ? "unfetched" : "ok");
  for (const loaded of session.loaded)
    putAppResult(session.book, loaded.name, {
      portOpen: true,
      manifestReachable: true,
      buildVersion: "1",
      zipUrl: null,
      zipMtime: null,
      zipHash: null,
      exposes: [],
      shared: [],
    });
  const first = session.nodes();
  const all = rows(first);
  assert.equal(all.length, 6, "one root and five edges");
  assert.equal(new Set(all.map((node) => node.id)).size, all.length);
  assert.deepEqual(
    rows(session.nodes()).map((node) => node.id),
    all.map((node) => node.id),
  );
  const shared = all.filter((node) => node.name === "shared");
  assert.deepEqual(shared.map((node) => node.children.length).sort(), [0, 1]);
  const reference = shared.find((node) => node.children.length === 0)!;
  assert.match(reference.tooltip, /Reference:/);
  session.relabel({ ...terms, treeReference: "Зависимости показаны выше." });
  const translatedReference = rows(session.nodes()).find((node) => node.id === reference.id)!;
  assert.match(translatedReference.tooltip, /Зависимости показаны выше/);
  assert.doesNotMatch(translatedReference.tooltip, /Reference:/);
  assert.equal(reference.kind, "unfetched");
  assert.match(reference.contextValue, /producer/);
  assert.equal(session.actionFor(reference)?.configFile, "/workspace/right/rsbuild.config.ts");
  assert.equal(
    session.actionFor(reference)?.producerConfigFile,
    "/workspace/shared/rsbuild.config.ts",
  );
  assert.equal(
    session.actionFor(reference)?.manifestUrl,
    "http://localhost:4100/shared/mf-manifest.json",
  );
});

test("cycles, disconnected roots and aliases remain visible with unique row IDs", () => {
  const session = sessionFor([
    app("entry", ["shared", "shared"]),
    app("shared", ["entry"]),
    app("island", ["other"]),
    app("other", ["island"]),
    app("standalone"),
  ]);
  const roots = session.nodes();
  assert.deepEqual(
    roots.map((node) => node.name),
    ["standalone", "entry", "island"],
  );
  const all = rows(roots);
  assert.equal(all.length, 8);
  assert.equal(new Set(all.map((node) => node.id)).size, all.length);
  assert.equal(all.filter((node) => node.name === "shared").length, 2);
  assert.equal(
    new Set(all.filter((node) => node.name === "shared").map((node) => node.linkId)).size,
    2,
  );
  assert.deepEqual(
    new Set(all.map((node) => node.name)),
    new Set(session.loaded.map((item) => item.name)),
  );
  session.setStructure("flat");
  assert.equal(session.nodes().length, 5);
  assert.ok(session.nodes().every((node) => node.children.length === 0));
});

for (const layers of [12, 100]) {
  test(`a ${layers}-layer shared DAG emits one row per edge`, () => {
    const apps = [app("entry", ["layer-0-a", "layer-0-b"])];
    for (let layer = 0; layer < layers; layer++) {
      const children = layer === layers - 1 ? [] : [`layer-${layer + 1}-a`, `layer-${layer + 1}-b`];
      for (const side of ["a", "b"]) apps.push(app(`layer-${layer}-${side}`, children));
    }
    const session = sessionFor(apps);
    let statuses = 0;
    session.typesForLink = () => {
      statuses++;
      return "unknown";
    };
    const all = rows(session.nodes());
    const edges = apps.reduce((sum, item) => sum + item.remotes.length, 0);
    assert.equal(all.length, edges + 1);
    assert.equal(statuses, edges);
    assert.equal(new Set(all.map((node) => node.id)).size, all.length);
    assert.deepEqual(new Set(all.map((node) => node.name)), new Set(apps.map((item) => item.name)));
  });
}
