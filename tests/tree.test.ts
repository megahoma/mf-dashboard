import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appProbeId,
  createProbeBook,
  putAppResult,
  putExternalResult,
  putLinkResult,
  type ArtifactProbe,
  type LocalApp,
} from "../src/entities/microfrontend/index.ts";
import { terms } from "../src/shared/config/index.ts";
import {
  beginRefetch,
  endRefetch,
  DashboardSession,
  type DashboardSettings,
} from "../src/widgets/mf-dashboard-tree/session.ts";

function app(overrides: Partial<LocalApp> & Pick<LocalApp, "name">): LocalApp {
  return {
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
    ...overrides,
  };
}

function artifact(overrides: Partial<ArtifactProbe> = {}): ArtifactProbe {
  return {
    manifestReachable: false,
    buildVersion: null,
    zipUrl: null,
    zipMtime: null,
    zipHash: null,
    exposes: [],
    shared: [],
    ...overrides,
  };
}

function settings(overrides: Partial<DashboardSettings> = {}): DashboardSettings {
  return {
    apps: undefined,
    envMode: "development",
    ignorePaths: [],
    extraManifestUrls: [],
    structure: "tree",
    ...overrides,
  };
}

test("a second refetch for the same link is rejected", () => {
  const pending = new Set<string>();
  assert.equal(beginRefetch(pending, "a\0b\0b"), true);
  assert.equal(beginRefetch(pending, "a\0b\0b"), false);
  assert.equal(beginRefetch(pending, "a\0c\0c"), true);
  endRefetch(pending, "a\0b\0b");
  assert.equal(beginRefetch(pending, "a\0b\0b"), true);
});

test("an empty app list stays empty and does not scan", async () => {
  let scans = 0;
  const session = new DashboardSession(
    {
      readSettings: () => settings(),
      writeApps() {
        throw new Error("no write");
      },
      scan() {
        scans += 1;
        return { app: app({ name: "app" }) };
      },
      loadKnown() {
        throw new Error("missing apps are not loaded");
      },
      async probe(_book, input) {
        assert.deepEqual(input.apps, []);
        assert.deepEqual(input.links, []);
      },
      roots: () => [{ name: "widget-1", path: "/widget-1" }],
    },
    createProbeBook(),
    () => {},
  );
  await session.refresh();
  assert.equal(scans, 0);
  assert.deepEqual(session.nodes(), []);
});

test("discover does not write an empty apps object when nothing is found", async () => {
  let writes = 0;
  const session = new DashboardSession(
    {
      readSettings: () => settings(),
      writeApps() {
        writes += 1;
      },
      scan: () => ({}),
      loadKnown() {
        return [];
      },
      async probe() {},
      roots: () => [{ name: "widget-1", path: "/widget-1" }],
    },
    createProbeBook(),
    () => {},
  );
  await session.discover();
  assert.equal(writes, 0);
  assert.deepEqual(session.nodes(), []);
});

test("refresh keeps the previous book until the probe settles", async () => {
  const previousExtra = "https://cdn.example/mf-manifest.json";
  const nextExtra = "https://next.example/mf-manifest.json";
  const book = createProbeBook();
  putAppResult(book, "app", { portOpen: true, ...artifact({ buildVersion: "old" }) });
  putLinkResult(book, {
    link: {
      consumer: "app",
      alias: "dep",
      remoteName: "dep",
      url: "http://127.0.0.1:4200/mf-manifest.json",
    },
    ...artifact(),
  });
  putExternalResult(book, previousExtra, artifact({ manifestReachable: true }));
  const visible = [app({ name: "app", port: 4100 })];
  let probeFlag: boolean | undefined;
  let duringKind: string | undefined;
  let changeFlag: boolean | undefined;
  const session: DashboardSession = new DashboardSession(
    {
      readSettings: () =>
        settings({
          apps: { app: { path: "." } },
          extraManifestUrls: [nextExtra],
          structure: "flat",
        }),
      writeApps() {},
      scan() {
        return {};
      },
      loadKnown: () => [app({ name: "app", port: 4100 })],
      async probe(target) {
        probeFlag = session.probeRunning;
        duringKind = session.nodes()[0]?.kind;
        assert.equal(session.loaded, visible);
        assert.deepEqual(session.extraUrls, [previousExtra]);
        assert.equal(book.apps.get(appProbeId("app"))?.buildVersion, "old");
        assert.equal(book.links.size, 1);
        assert.equal(book.extras.size, 1);
        putAppResult(target, "app", { portOpen: false, ...artifact({ buildVersion: "new" }) });
        assert.equal(book.apps.get(appProbeId("app"))?.buildVersion, "old");
        assert.equal(session.structure, "flat");
        session.setStructure("tree");
      },
      roots: () => [{ name: "widget-1", path: "/widget-1" }],
    },
    book,
    () => {
      changeFlag = session.probeRunning;
    },
  );
  session.loaded = visible;
  session.extraUrls = [previousExtra];
  await session.refresh();
  assert.equal(probeFlag, true);
  assert.equal(duringKind, "listen");
  assert.equal(changeFlag, false);
  assert.equal(session.probeRunning, false);
  assert.notEqual(session.loaded, visible);
  assert.equal(book.apps.get(appProbeId("app"))?.buildVersion, "new");
  assert.equal(book.links.size, 0);
  assert.equal(book.extras.size, 0);
  assert.equal(session.nodes()[0]?.kind, "silent");
  assert.equal(
    session.nodes().some((node) => node.name === "cdn.example"),
    false,
  );
  assert.equal(
    session.nodes().some((node) => node.name === "next.example"),
    true,
  );
  assert.deepEqual(session.extraUrls, [nextExtra]);
  assert.equal(session.structure, "tree");

  const kept = createProbeBook();
  putAppResult(kept, "app", { portOpen: true, ...artifact({ buildVersion: "kept" }) });
  const keptLoaded = [app({ name: "app", port: 4100 })];
  let rejectedChange = false;
  const failing = new DashboardSession(
    {
      readSettings: () =>
        settings({
          apps: { other: { path: "." } },
          extraManifestUrls: ["https://other.example/mf-manifest.json"],
          structure: "flat",
        }),
      writeApps() {},
      scan() {
        return {};
      },
      loadKnown: () => [app({ name: "other", port: 1 })],
      async probe() {
        throw new Error("down");
      },
      roots: () => [{ name: "widget-1", path: "/widget-1" }],
    },
    kept,
    () => {
      rejectedChange = true;
    },
  );
  failing.loaded = keptLoaded;
  await assert.rejects(() => failing.refresh(), /down/);
  assert.equal(failing.probeRunning, false);
  assert.equal(rejectedChange, false);
  assert.equal(failing.loaded, keptLoaded);
  assert.equal(failing.nodes()[0]?.name, "app");
  assert.equal(failing.nodes()[0]?.kind, "listen");
  assert.equal(failing.book.apps.get(appProbeId("app"))?.buildVersion, "kept");
  assert.deepEqual(failing.extraUrls, []);
  assert.equal(failing.structure, "tree");
});

test("a failed probe preserves a structure toggle", async () => {
  let changes = 0;
  const session = new DashboardSession(
    {
      readSettings: () => settings(),
      writeApps() {},
      scan() {
        return {};
      },
      loadKnown: () => [],
      async probe() {
        session.setStructure("flat");
        throw new Error("down");
      },
      roots: () => [],
    },
    createProbeBook(),
    () => {
      changes += 1;
    },
  );
  await assert.rejects(() => session.refresh(), /down/);
  assert.equal(session.structure, "flat");
  assert.equal(changes, 2);
});

test("a failed refresh keeps the previous problem drafts", async () => {
  const linkUrl = "http://127.0.0.1:4200/mf-manifest.json";
  const extraUrl = "https://cdn.example/mf-manifest.json";
  const settingsFile = "/widget-1/.vscode/settings.json";
  const book = createProbeBook();
  putAppResult(book, "app", { portOpen: true, ...artifact() });
  putAppResult(book, "dep", { portOpen: true, ...artifact() });
  putLinkResult(book, {
    link: { consumer: "app", alias: "dep", remoteName: "dep", url: linkUrl },
    ...artifact({ manifestReachable: true }),
  });
  const session: DashboardSession = new DashboardSession(
    {
      readSettings: () => settings({ apps: { app: { path: "." } }, extraManifestUrls: [extraUrl] }),
      writeApps() {},
      scan() {
        return {};
      },
      loadKnown: () => session.loaded,
      async probe() {
        throw new Error("down");
      },
      roots: () => [{ name: "widget-1", path: "/widget-1" }],
    },
    book,
    () => {},
  );
  session.typesForLink = () => "unfetched";
  session.loaded = [
    app({
      name: "app",
      port: 4100,
      remotes: [{ alias: "dep", name: "dep", url: linkUrl }],
    }),
    app({ name: "dep", port: 4200 }),
  ];
  session.extraUrls = [extraUrl];
  session.structure = "flat";
  const linkDraft = {
    file: "/widget-1/rsbuild.config.ts",
    message: "app → dep: " + terms.unfetched,
    severity: "information" as const,
    kind: "unfetched" as const,
  };
  const extraDraft = {
    file: settingsFile,
    message: "cdn.example: " + terms.noAnswer,
    severity: "warning" as const,
    kind: "noAnswer" as const,
  };
  assert.deepEqual(session.problemDrafts(settingsFile), [linkDraft, extraDraft]);
  assert.deepEqual(session.problemDrafts(null), [linkDraft]);
  const before = session.problemDrafts(settingsFile);
  await assert.rejects(() => session.refresh(), /down/);
  session.relabel(session.terms);
  assert.equal(session.probeRunning, false);
  assert.deepEqual(session.problemDrafts(settingsFile), before);
});

test("a link that reaches listen leaves the problem drafts", () => {
  const linkUrl = "http://127.0.0.1:4200/mf-manifest.json";
  const book = createProbeBook();
  putAppResult(book, "app", { portOpen: true, ...artifact() });
  putAppResult(book, "dep", { portOpen: true, ...artifact() });
  putLinkResult(book, {
    link: { consumer: "app", alias: "dep", remoteName: "dep", url: linkUrl },
    ...artifact({ manifestReachable: true }),
  });
  let typesState: "unfetched" | "ok" = "unfetched";
  const session = new DashboardSession(
    {
      readSettings: () => settings(),
      writeApps() {},
      scan() {
        return {};
      },
      loadKnown: () => [],
      async probe() {},
      roots: () => [],
    },
    book,
    () => {},
  );
  session.typesForLink = () => typesState;
  session.loaded = [
    app({
      name: "app",
      port: 4100,
      remotes: [{ alias: "dep", name: "dep", url: linkUrl }],
    }),
    app({ name: "dep", port: 4200 }),
  ];
  assert.deepEqual(session.problemDrafts(null), [
    {
      file: "/widget-1/rsbuild.config.ts",
      message: "app → dep: " + terms.unfetched,
      severity: "information",
      kind: "unfetched",
    },
  ]);
  typesState = "ok";
  assert.deepEqual(session.problemDrafts(null), []);
});

test("relabel uses the next terms without scanning", async () => {
  let scans = 0;
  let probes = 0;
  let fires = 0;
  const stored = settings({ apps: { app: { path: "widget-1" } } });
  const book = createProbeBook();
  const session = new DashboardSession(
    {
      readSettings: () => stored,
      writeApps() {},
      scan() {
        scans += 1;
        return {};
      },
      loadKnown: () => [app({ name: "app", port: 4100, folder: "/widget-1" })],
      async probe(target) {
        probes += 1;
        putAppResult(target, "app", { portOpen: true, ...artifact() });
      },
      roots: () => [{ name: "widget-1", path: "/widget-1" }],
    },
    book,
    () => {
      fires += 1;
    },
  );
  await session.refresh();
  const before = fires;
  session.relabel({ ...terms, listen: "работает", folder: "каталог", localPort: "локальный порт" });
  assert.equal(scans, 0);
  assert.equal(probes, 1);
  assert.equal(fires, before + 1);
  assert.match(session.nodes()[0]?.description ?? "", /работает/);
  assert.match(session.nodes()[0]?.tooltip ?? "", /каталог/);
});

test("each row tooltip uses that row's manifest modules", () => {
  const linkUrl = "http://127.0.0.1:4200/mf-manifest.json";
  const extraUrl = "https://cdn.example/mf-manifest.json";
  const book = createProbeBook();
  putAppResult(book, "app", {
    portOpen: true,
    ...artifact({
      manifestReachable: true,
      exposes: ["./App"],
      shared: [{ name: "react", version: "18.2.0", singleton: true }],
    }),
  });
  putAppResult(book, "dep", {
    portOpen: true,
    ...artifact({ manifestReachable: true, exposes: ["./Producer"] }),
  });
  putAppResult(book, "plain", { portOpen: false, ...artifact() });
  putLinkResult(book, {
    link: { consumer: "app", alias: "dep", remoteName: "dep", url: linkUrl },
    ...artifact({ manifestReachable: true, exposes: ["./Link"] }),
  });
  putExternalResult(book, extraUrl, artifact({ manifestReachable: true, exposes: ["./Extra"] }));
  const session = new DashboardSession(
    {
      readSettings: () => settings(),
      writeApps() {
        throw new Error("no write");
      },
      scan() {
        throw new Error("no scan");
      },
      loadKnown() {
        throw new Error("no load");
      },
      async probe() {
        throw new Error("no probe");
      },
      roots: () => [],
    },
    book,
    () => {},
  );
  session.loaded = [
    app({
      name: "app",
      port: 4100,
      remotes: [{ alias: "dep", name: "dep", url: linkUrl }],
    }),
    app({ name: "dep", port: 4200, folder: "/widget-1/dep" }),
    app({ name: "plain", port: 4300 }),
  ];
  session.extraUrls = [extraUrl];

  const nodes = session.nodes();
  const appRow = nodes.find((node) => node.name === "app");
  const plain = nodes.find((node) => node.name === "plain");
  const extra = nodes.find((node) => node.name === "cdn.example");
  const link = appRow?.children.find((node) => node.name === "dep");
  assert.ok(appRow);
  assert.ok(plain);
  assert.ok(extra);
  assert.ok(link);

  assert.equal(appRow.kind, "listen");
  assert.equal(appRow.description, ":4100 · " + terms.listen);
  assert.ok(appRow.tooltip.indexOf("exposes: ./App") > appRow.tooltip.indexOf(terms.listen));
  assert.ok(
    appRow.tooltip.indexOf("shared: react@18.2.0 singleton") >
      appRow.tooltip.indexOf("exposes: ./App"),
  );
  assert.equal(appRow.tooltip.includes("./Producer"), false);
  assert.equal(appRow.tooltip.includes("./Link"), false);

  assert.equal(link.kind, "listen");
  assert.equal(link.description, ":4200 · " + terms.listen);
  assert.ok(link.tooltip.indexOf("exposes: ./Link") > link.tooltip.indexOf(terms.typesUnknown));
  assert.equal(link.tooltip.includes("shared:"), false);
  assert.equal(link.tooltip.includes("./Producer"), false);
  assert.equal(link.tooltip.includes("./App"), false);

  assert.equal(extra.kind, "answers");
  assert.equal(extra.description, "cdn.example · " + terms.answers);
  assert.ok(extra.tooltip.indexOf("exposes: ./Extra") > extra.tooltip.indexOf(terms.noWorkspace));

  assert.equal(plain.kind, "silent");
  assert.equal(plain.tooltip.includes("exposes:"), false);
  assert.equal(plain.tooltip.includes("shared:"), false);
});

test("the provider registers the tree without a view message", () => {
  const provider = fs.readFileSync(
    new URL("../src/widgets/mf-dashboard-tree/provider.ts", import.meta.url),
    "utf8",
  );
  const extension = fs.readFileSync(new URL("../src/app/extension.ts", import.meta.url), "utf8");
  const itemStart = provider.indexOf("getTreeItem(");
  const itemEnd = provider.indexOf("getChildren(", itemStart);
  assert.equal(/\.message\b/.test(provider.slice(itemStart, itemEnd)), false);
  const notifyStart = provider.indexOf("private notify()");
  const notifyEnd = provider.indexOf("private publishProblems(", notifyStart);
  assert.match(provider.slice(notifyStart, notifyEnd), /if \(this\.disposed\) return/);
  assert.match(provider, /new vscode\.ThemeIcon\(icons\[row\.kind\]\)/);
  assert.match(provider, /description = row\.description/);
  assert.match(extension, /selectedTerms/);
  assert.match(extension, /onDidChangeTerms/);
  assert.match(extension, /widgets\/mf-dashboard-tree\/index\.ts/);
  assert.match(extension, /registerTreeDataProvider\("mf-dashboard"/);
  assert.match(extension, /mf-dashboard\.refresh/);
  assert.match(extension, /mf-dashboard\.discover/);
  assert.match(extension, /mf-dashboard\.refetchTypes/);
  assert.match(extension, /mf-dashboard\.useFlat/);
  assert.match(extension, /mf-dashboard\.useTree/);
});

function navigationSession(): DashboardSession {
  return new DashboardSession(
    {
      readSettings: () => settings(),
      writeApps() {},
      scan: () => ({}),
      loadKnown: () => [],
      async probe() {},
      roots: () => [],
    },
    createProbeBook(),
    () => {},
  );
}

test("menu and click require a types directory inside the app for apps and links", () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "mf-tree-actions-"));
  try {
    const folder = path.join(root, "app");
    fs.mkdirSync(folder);
    const typesRoot = path.join(folder, "@mf-types");
    const session = navigationSession();
    session.loaded = [
      app({ name: "app", folder, remotes: [{ alias: "dep", name: "dep", url: null }] }),
    ];
    const assertTypes = (appExpected: boolean, linkExpected: boolean) => {
      const row = session.nodes()[0];
      const link = row.children[0];
      for (const [node, expected] of [
        [row, appExpected],
        [link, linkExpected],
      ] as const) {
        assert.equal(node.contextValue.split(" ").includes("types"), expected);
        assert.equal(session.actionFor(node)?.typesDir != null, expected);
      }
    };
    assertTypes(false, false);
    fs.writeFileSync(typesRoot, "file");
    assertTypes(false, false);
    fs.rmSync(typesRoot);
    fs.mkdirSync(typesRoot);
    fs.writeFileSync(path.join(typesRoot, "dep"), "file");
    assertTypes(true, false);
    fs.rmSync(path.join(typesRoot, "dep"));
    fs.mkdirSync(path.join(typesRoot, "dep"));
    assertTypes(true, true);
    const oldRow = session.nodes()[0];
    fs.rmSync(typesRoot, { recursive: true });
    assert.equal(session.actionFor(oldRow)?.typesDir, null);
    for (const typesFolder of [root, "../", "../app/@mf-types"]) {
      session.loaded[0].typesFolder = typesFolder;
      assertTypes(false, false);
    }
    session.loaded[0].typesFolder = "@mf-types";
    fs.symlinkSync(root, typesRoot, "dir");
    assertTypes(false, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("row actions resolve only current configured targets and reject malformed arguments", () => {
  const session = navigationSession();
  const url = "https://configured.example/mf-manifest.json";
  const remote = { alias: "dep", name: "dep", url };
  session.loaded = [app({ name: "app", remotes: [remote] }), app({ name: "dep" })];
  session.extraUrls = [url];
  const row = session.nodes()[0];
  const link = row.children[0];
  const extra = session.nodes().find((node) => node.id === `extra:${url}`);
  assert.ok(extra);
  assert.equal(session.actionFor(row)?.configFile, session.loaded[0].configFile);
  assert.equal(session.actionFor(link)?.manifestUrl, url);
  assert.equal(session.actionFor(extra)?.manifestUrl, url);
  for (const node of [
    undefined,
    null,
    "wrong",
    {},
    { id: 1, name: "app" },
    { ...extra, id: "extra:https://unconfigured.example/secret" },
    { ...row, id: "app:missing" },
    { ...link, linkId: "app\0missing\0dep" },
    { ...link, linkId: "app\0dep\0dep\0suffix" },
  ]) {
    assert.equal(session.actionFor(node), null);
  }
  remote.url = "https://new.example/mf-manifest.json";
  assert.equal(session.actionFor(link)?.manifestUrl, remote.url);
  session.loaded[0].remotes = [];
  assert.equal(session.actionFor(link), null);
  session.extraUrls = [];
  assert.equal(session.actionFor(extra), null);
  session.loaded = [];
  assert.equal(session.actionFor(row), null);
});

test("refresh carries ZIP facts into staging and only commits them on success", async () => {
  const book = createProbeBook();
  const url = "https://example.com/types.zip";
  const original = { zipHash: "old", zipMtime: 1000 };
  book.zips.set(url, original);
  let fail = true;
  const session = new DashboardSession(
    {
      readSettings: () => settings(),
      roots: () => [],
      writeApps() {},
      scan: () => ({}),
      loadKnown: () => [],
      async probe(staged) {
        assert.deepEqual(staged.zips.get(url), original);
        assert.notEqual(staged.zips, book.zips);
        staged.zips.set(url, { zipHash: "new", zipMtime: 2000 });
        if (fail) throw new Error("probe failed");
      },
    },
    book,
  );
  await assert.rejects(() => session.refresh(), /probe failed/);
  assert.deepEqual(book.zips.get(url), original);
  fail = false;
  await session.refresh();
  assert.deepEqual(book.zips.get(url), { zipHash: "new", zipMtime: 2000 });
});
