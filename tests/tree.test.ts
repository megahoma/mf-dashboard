import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  createProbeBook,
  putAppResult,
  putExternalResult,
  putLinkResult,
  type ArtifactProbe,
  type LocalApp,
} from "../src/entities/microfrontend/index.ts";
import { icons, terms } from "../src/shared/config/index.ts";
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
      async probe(input) {
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

test("refresh keeps the cleared book marked until the probe settles", async () => {
  const book = createProbeBook();
  putAppResult(book, "app", { portOpen: true, ...artifact() });
  putLinkResult(book, {
    link: {
      consumer: "app",
      alias: "dep",
      remoteName: "dep",
      url: "http://127.0.0.1:4200/mf-manifest.json",
    },
    ...artifact(),
  });
  putExternalResult(book, "https://cdn.example/mf-manifest.json", artifact());
  let probeFlag: boolean | undefined;
  let probeApps = -1;
  let probeLinks = -1;
  let probeExtras = -1;
  let changeFlag: boolean | undefined;
  const session = new DashboardSession(
    {
      readSettings: () => settings({ apps: { app: { path: "." } } }),
      writeApps() {},
      scan() {
        return {};
      },
      loadKnown: () => [app({ name: "app" })],
      async probe() {
        probeFlag = session.probeRunning;
        probeApps = book.apps.size;
        probeLinks = book.links.size;
        probeExtras = book.extras.size;
      },
      roots: () => [{ name: "widget-1", path: "/widget-1" }],
    },
    book,
    () => {
      changeFlag = session.probeRunning;
    },
  );
  await session.refresh();
  assert.equal(probeFlag, true);
  assert.equal(probeApps, 0);
  assert.equal(probeLinks, 0);
  assert.equal(probeExtras, 0);
  assert.equal(changeFlag, false);
  assert.equal(session.probeRunning, false);

  let rejectedChange = false;
  const failing = new DashboardSession(
    {
      readSettings: () => settings({ apps: { app: { path: "." } } }),
      writeApps() {},
      scan() {
        return {};
      },
      loadKnown: () => [app({ name: "app" })],
      async probe() {
        throw new Error("down");
      },
      roots: () => [{ name: "widget-1", path: "/widget-1" }],
    },
    createProbeBook(),
    () => {
      rejectedChange = true;
    },
  );
  await assert.rejects(() => failing.refresh(), /down/);
  assert.equal(failing.probeRunning, false);
  assert.equal(rejectedChange, false);
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
  const session = new DashboardSession(
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
      async probe() {
        probes += 1;
        putAppResult(book, "app", { portOpen: true, ...artifact() });
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
