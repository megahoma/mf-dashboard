import { createLogger } from "../src/shared/lib/logging.ts";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { developmentFederationConfig, localApp } from "./support/app.ts";
import {
  createLoopbackNet,
  createProbeCycle,
  probeApp,
  putAppResult,
  remoteLink,
} from "../src/entities/microfrontend/index.ts";
import { shellQuote } from "../src/shared/lib/shell.ts";
import * as vscode from "./support/vscode.ts";
import { terms, type DashboardTerms } from "../src/shared/config/index.ts";
import { KnownAppsWorker } from "../src/widgets/mf-dashboard-tree/lib/known-apps-worker.mts";
import type { DashboardNode } from "../src/widgets/mf-dashboard-tree/models/presentation.ts";
import type { TreeView, TreeViewSelectionChangeEvent, WebviewView } from "vscode";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "vscode") {
      return { url: new URL("./support/vscode.ts", import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { linkRowId } = await import("../src/widgets/mf-dashboard-tree/lib/presentation.ts");
const { MfDashboardProvider } = await import("../src/widgets/mf-dashboard-tree/models/provider.ts");
const { DashboardDetails } = await import("../src/widgets/mf-dashboard-tree/models/details.ts");

const workspace = vscode.workspace as typeof vscode.workspace & {
  workspaceFolders?: { name: string; uri: vscode.Uri }[];
  workspaceFile?: { scheme: string; fsPath: string } | null;
};

type Provider = InstanceType<typeof MfDashboardProvider>;

function providerFor(
  events?: { level: string; text: string }[],
  persist?: () => void | PromiseLike<void>,
): Provider {
  const log = events
    ? createLogger({
        enabled: (level) => level === "info" || level === "warn" || level === "error",
        write: (level, text) => events.push({ level, text }),
      })
    : undefined;
  const provider = new MfDashboardProvider(() => terms, undefined, persist, log);
  return provider;
}

test("a local intermediate app with an unknown port retains its dependency subtree", (t) => {
  const provider = providerFor();
  t.after(() => provider.dispose());
  provider.session.loaded = [
    localApp("entry", "/entry", { remotes: [{ alias: "middle", name: "middle", url: null }] }),
    localApp("middle", "/middle", {
      port: null,
      remotes: [{ alias: "leaf", name: "leaf", url: null }],
    }),
    localApp("leaf", "/leaf", { remotes: [{ alias: "entry", name: "entry", url: null }] }),
  ];
  const root = provider.getChildren()[0];
  assert.equal(root.name, "entry");
  const middle = root.children[0];
  assert.equal(middle.name, "middle");
  assert.match(middle.description, new RegExp(terms.unknownPort));
  const leaf = middle.children[0];
  assert.equal(leaf?.name, "leaf");
  assert.equal(leaf.children[0].name, "entry");
  assert.equal(leaf.children[0].children.length, 0);
  assert.equal(provider.findAppRow("leaf"), leaf);
  assert.equal(provider.getParent(leaf), middle);
  assert.equal(provider.getParent(root), undefined);
  provider.setStructure("flat");
  assert.deepEqual(
    provider.getChildren().map((row) => row.name),
    ["entry", "leaf", "middle"],
  );
});

test("details follow the selected row and link to its direct consumers", async (t) => {
  const provider = providerFor();
  t.after(() => provider.dispose());
  const app: DashboardNode = {
    id: "app:gallery",
    name: "gallery",
    kind: "listen",
    description: "listening",
    tooltip: "Port: 4200",
    contextValue: "listen",
    linkId: null,
    children: [],
  };
  const link: DashboardNode = {
    ...app,
    id: "gallery-link",
    linkId: "portal\0gallery\0gallery",
    contextValue: "listen config producer manifest types",
    manifest: {
      url: "https://example.test/mf-manifest.json?x=1&y=2",
      status: "noAnswer",
      label: terms.requestNetworkError,
    },
    tooltip: [
      "connection: portal → gallery",
      "URL: https://example.test/mf-manifest.json?x=1&y=2",
      terms.requestNetworkError,
      "exposes: <img src=x>&",
      terms.treeReference,
    ].join("\n"),
  };
  const editor: DashboardNode = { ...app, id: "app:editor", name: "editor" };
  const portal: DashboardNode = { ...app, id: "app:portal", name: "portal" };
  const remote = { alias: "gallery", name: "gallery", url: null };
  provider.session.loaded = [
    localApp("portal", "/portal", {
      consumeTypes: true,
      remotes: [
        remote,
        { ...remote, alias: "preview" },
        { alias: "menu", name: "menu", url: null },
      ],
    }),
    localApp("editor", "/editor", { remotes: [remote] }),
    localApp("shell", "/shell", { remotes: [{ alias: "portal", name: "portal", url: null }] }),
    localApp("gallery", "/gallery"),
  ];
  const checkedAt = new Date(2026, 0, 1, 10, 30).getTime();
  let typeDetails: NonNullable<ReturnType<Provider["typeDetails"]>> = {
    checkedAt,
    status: "unknown",
    archiveMatch: "matches",
    sourceFreshness: "unknown",
  };
  t.mock.method(provider, "typeDetails", (id: string) => {
    if (id === "portal\0preview\0gallery")
      return { status: "unfetched", archiveMatch: "differs", sourceFreshness: "unknown" };
    if (id === "portal\0menu\0menu")
      return { status: "unchecked", archiveMatch: "unknown", sourceFreshness: "unknown" };
    return typeDetails;
  });
  let rows = [{ ...app, children: [link] }];
  t.mock.method(provider.session, "nodes", () => rows);
  const selection = new vscode.EventEmitter<TreeViewSelectionChangeEvent<DashboardNode>>();
  const visibility = new vscode.EventEmitter<void>();
  const disposal = new vscode.EventEmitter<void>();
  const tree = {
    selection: [] as DashboardNode[],
    onDidChangeSelection: selection.event,
    async reveal(node: DashboardNode, options: { select: boolean }) {
      assert.equal(options.select, true);
      this.selection = [node];
      selection.fire({ selection: this.selection });
    },
  };
  const view = {
    webview: { html: "" },
    visible: true,
    onDidChangeVisibility: visibility.event,
    onDidDispose: disposal.event,
  };
  const details = new DashboardDetails(tree as unknown as TreeView<DashboardNode>, provider);
  t.after(() => details.dispose());
  details.resolveWebviewView(view as unknown as WebviewView);
  assert.match(view.webview.html, /Select a microfrontend/);
  assert.equal(provider.getTreeItem(link).tooltip, undefined);
  assert.match(provider.getTreeItem(link).accessibilityInformation?.label ?? "", /listening/);

  tree.selection = [link];
  selection.fire({ selection: tree.selection });
  assert.match(view.webview.html, /<th scope="col">Server comparison<\/th>/);
  assert.match(view.webview.html, /<th scope="col">Source check<\/th>/);
  assert.match(
    view.webview.html,
    /<th scope="row">gallery<\/th><td>Types match<\/td><td>Freshness unknown<\/td>/,
  );
  assert.match(view.webview.html, /<h2 id="consumers-title">Consumers<\/h2>/);
  assert.deepEqual(
    [
      ...view.webview.html.matchAll(
        /<li><a class="navigation-link" href="command:mf-dashboard\.openConsumerDetails\?[^"\n]+"[^>]*>.*?<span>([^<]+)<\/span><\/a><\/li>/g,
      ),
    ].map(([, name]) => name),
    ["editor", "portal"],
  );
  assert.match(view.webview.html, /<p class="context">For portal<\/p>/);
  assert.ok(
    view.webview.html.indexOf('id="consumers-title"') <
      view.webview.html.indexOf('id="types-title"'),
  );
  assert.ok(
    view.webview.html.indexOf('id="manifest-title"') <
      view.webview.html.indexOf('id="types-title"'),
  );
  assert.doesNotMatch(String(provider.getTreeItem(link).description), /@mf-types/);
  assert.ok(
    view.webview.html.includes(
      `<dt>types last checked</dt><dd>${new Date(checkedAt).toLocaleString()}</dd>`,
    ),
  );
  assert.match(view.webview.html, /<dt>connection<\/dt><dd>portal → gallery<\/dd>/);
  assert.match(
    view.webview.html,
    /<dt>URL<\/dt><dd><div class="url-value">.*<span>https:\/\/example\.test\/mf-manifest\.json\?x=1&amp;y=2<\/span>/,
  );
  assert.match(
    view.webview.html,
    /class="url-status noAnswer" role="img" aria-label="network error"/,
  );
  assert.match(view.webview.html, /<dt>Status<\/dt><dd>listening<\/dd>/);
  assert.doesNotMatch(view.webview.html, /title="Open manifest"/);
  assert.match(view.webview.html, /<dt>exposes<\/dt><dd>&lt;img src=x&gt;&amp;<\/dd>/);
  assert.doesNotMatch(view.webview.html, /Reference:|<p class="notes">network error/);
  assert.doesNotMatch(view.webview.html, /<dt>Port<\/dt>|<img/);
  const actionLinks = [
    ...view.webview.html.matchAll(
      /href="command:mf-dashboard\.details\.runConnectionAction\?([^"]+)" title="([^"]+)"/g,
    ),
  ];
  assert.deepEqual(
    actionLinks.map(([, , label]) => label),
    ["Open config", "Open producer config", "Reveal types"],
  );
  const execute = t.mock.method(vscode.commands, "executeCommand");
  const runAction = vscode.registeredCommands.get("mf-dashboard.details.runConnectionAction");
  assert.ok(runAction);
  await runAction(...(JSON.parse(decodeURIComponent(actionLinks[0][1])) as unknown[]));
  await runAction(link.id, "unrelatedCommand");
  await runAction(link.id, "openManifest");
  await runAction(app.id, "openConfig");
  assert.deepEqual(
    execute.mock.calls.map(({ arguments: args }) => args),
    [["mf-dashboard.openConfig", link]],
  );
  const clipboard = t.mock.method(vscode.env.clipboard, "writeText", async () => {});
  const copyUrl = vscode.registeredCommands.get("mf-dashboard.copyManifestUrl");
  assert.ok(copyUrl);
  await copyUrl(link.id);
  await copyUrl("missing");
  assert.deepEqual(
    clipboard.mock.calls.map(({ arguments: args }) => args),
    [[link.manifest?.url]],
  );
  rows = [
    {
      ...app,
      children: [
        { ...link, manifest: { url: link.manifest!.url, status: "answers", label: terms.answers } },
      ],
    },
  ];
  provider.relabel();
  assert.match(view.webview.html, /class="icon-action"[^>]+aria-label="Open manifest"/);
  assert.match(view.webview.html, /class="navigation-link"[^>]+title="Open manifest"/);
  await runAction(link.id, "openManifest");
  assert.equal(execute.mock.calls.at(-1)?.arguments[0], "mf-dashboard.openManifest");

  assert.doesNotMatch(view.webview.html, /Open microfrontend in browser/);
  const openApp = vscode.registeredCommands.get("mf-dashboard.details.openApp");
  assert.ok(openApp);
  const browser = t.mock.method(vscode.env, "openExternal");
  await openApp(link.id);
  assert.equal(browser.mock.callCount(), 0);
  putAppResult(provider.session.book, "gallery", {
    portOpen: true,
    manifestReachable: false,
    buildVersion: null,
    zipMtime: null,
    zipHash: null,
    zipUrl: null,
    exposes: [],
    shared: [],
  });
  provider.relabel();
  assert.match(
    view.webview.html,
    /<header>.*Open microfrontend in browser \(http:\/\/127\.0\.0\.1:4100\/\)/,
  );
  await openApp(link.id);
  assert.equal(browser.mock.calls[0]?.arguments[0].path, "//127.0.0.1:4100/");
  provider.session.book.apps.clear();

  typeDetails = {
    status: "unknown",
    archiveMatch: "unknown",
    sourceFreshness: "unknown",
    startToCheck: true,
  };
  rows = [{ ...app, children: [{ ...link, kind: "silent", tooltip: "network error\nstopped" }] }];
  provider.relabel();
  assert.match(view.webview.html, /Start this microfrontend to check @mf-types\./);
  assert.match(view.webview.html, /<dt>Status<\/dt><dd>stopped<\/dd>/);
  assert.doesNotMatch(view.webview.html, /Open microfrontend in browser|title="Open manifest"/);
  assert.doesNotMatch(
    view.webview.html,
    /Comparison unavailable|Freshness unknown|<h2 id="manifest-title"/,
  );
  typeDetails = { ...typeDetails, status: "unfetched", archiveMatch: "missing" };
  provider.relabel();
  assert.match(
    view.webview.html,
    /<td>Types not installed<\/td><td class="start-hint">Start this microfrontend to check @mf-types\.<\/td>/,
  );

  // A collapsed tree can drop its cached elements without changing the selection.
  tree.selection = [];
  typeDetails = { ...typeDetails, status: "changed", archiveMatch: "unknown" };
  rows = [{ ...app, children: [{ ...link, kind: "silent", tooltip: terms.typesChanged }] }];
  provider.relabel();
  assert.doesNotMatch(view.webview.html, /<p class="notes">/);
  const changedTypes =
    /<td>Installed types changed<\/td><td class="start-hint">Start this microfrontend to check @mf-types\.<\/td>/;
  assert.match(view.webview.html, changedTypes);

  view.visible = false;
  rows = [app, editor];
  provider.relabel();
  assert.match(view.webview.html, changedTypes);
  view.visible = true;
  visibility.fire();
  assert.match(view.webview.html, /Select a microfrontend/);

  disposal.fire();
  tree.selection = [app];
  selection.fire({ selection: tree.selection });
  assert.match(view.webview.html, /Select a microfrontend/);

  tree.selection = [];
  const reopened = { ...view, webview: { html: "" } };
  details.resolveWebviewView(reopened as unknown as WebviewView);
  assert.match(reopened.webview.html, /<dt>Port<\/dt><dd>4200<\/dd>/);
  assert.match(reopened.webview.html, /<h2 id="consumers-title">Consumers<\/h2>/);
  assert.doesNotMatch(reopened.webview.html, /<ul class="connection-actions">/);
  assert.doesNotMatch(reopened.webview.html, /For portal/);

  const href = reopened.webview.html
    .match(/href="command:([^?]+)\?([^"]+)"[^>]*>.*?<span>editor<\/span>/)
    ?.slice(1);
  assert.ok(href);
  const [command, encodedArgs] = href;
  const openConsumer = vscode.registeredCommands.get(command);
  assert.ok(openConsumer);
  await openConsumer(...(JSON.parse(decodeURIComponent(encodedArgs)) as unknown[]));
  assert.deepEqual(tree.selection, [editor]);
  assert.match(reopened.webview.html, /<h1>editor<\/h1>/);
  await openConsumer("missing");
  assert.deepEqual(tree.selection, [editor]);

  typeDetails = { status: "ok", archiveMatch: "matches", sourceFreshness: "fresh" };
  rows = [app, portal, editor];
  provider.setStructure("flat");
  selection.fire({ selection: [portal] });
  assert.match(
    reopened.webview.html,
    /<th scope="row">gallery<\/th><td>Types match<\/td><td>Archive is up to date<\/td>/,
  );
  assert.match(
    reopened.webview.html,
    /<th scope="row">gallery \(preview\)<\/th><td>Types differ<\/td><td>Freshness unknown<\/td>/,
  );
  assert.match(
    reopened.webview.html,
    /<th scope="row">menu<\/th><td colspan="2">types not checked<\/td>/,
  );
  assert.doesNotMatch(reopened.webview.html, /For portal/);

  selection.fire({ selection: [] });
  assert.match(reopened.webview.html, /Select a microfrontend/);
});

test("Details opens recognized manifests even without a types ZIP", async (t) => {
  const provider = providerFor();
  const app = localApp("catalog", "/catalog", {
    port: 4500,
    manifest: true,
    manifestPath: "/metadata",
  });
  provider.session.loaded = [app];
  const selection = new vscode.EventEmitter<void>();
  const visibility = new vscode.EventEmitter<void>();
  const disposal = new vscode.EventEmitter<void>();
  const tree = {
    selection: [provider.getChildren()[0]],
    onDidChangeSelection: selection.event,
  };
  const view = {
    visible: true,
    webview: { html: "" },
    onDidChangeVisibility: visibility.event,
    onDidDispose: disposal.event,
  };
  const details = new DashboardDetails(tree as unknown as TreeView<DashboardNode>, provider);
  t.after(() => {
    details.dispose();
    provider.dispose();
  });
  details.resolveWebviewView(view as unknown as WebviewView);
  const net = { ...createLoopbackNet(), connect: async () => true };
  let response = new Response("<!doctype html><div id='app'></div>", {
    headers: { "content-type": "text/html" },
  });
  t.mock.method(globalThis, "fetch", async () => response.clone());

  for (const fallback of [
    response,
    Response.json({ id: "catalog", name: "catalog", metaData: {} }),
  ]) {
    response = fallback;
    putAppResult(provider.session.book, app.name, await probeApp(app, net));
    provider.relabel();
    assert.match(view.webview.html, /<dt>Status<\/dt><dd>listening<\/dd>/);
    assert.match(
      view.webview.html,
      /class="url-status noAnswer" role="img" aria-label="Expected a Module Federation manifest"/,
    );
    assert.match(view.webview.html, /title="Copy URL"/);
    assert.doesNotMatch(view.webview.html, /title="Open manifest"/);
  }

  const manifest = {
    id: "catalog",
    name: "catalog",
    metaData: {
      name: "catalog",
      globalName: "catalog",
      type: "APP",
      buildInfo: { buildVersion: "local", buildName: "catalog" },
      publicPath: "auto",
      remoteEntry: { name: "remoteEntry.js", path: "", type: "global" },
    },
    remotes: [],
  };
  response = new Response(JSON.stringify(manifest), { headers: { "content-type": "text/plain" } });
  const valid = await probeApp(app, net);
  assert.equal(valid.zipUrl, null);
  putAppResult(provider.session.book, app.name, valid);
  provider.relabel();
  assert.match(view.webview.html, /class="url-status answers" role="img" aria-label="reachable"/);
  assert.match(view.webview.html, /class="icon-action"[^>]+aria-label="Open manifest"/);
  assert.match(view.webview.html, /class="navigation-link"[^>]+title="Open manifest"/);
});

test("external manifest status distinguishes HTML from Vite import-map manifests", async (t) => {
  const provider = providerFor();
  t.after(() => provider.dispose());
  const url = "https://catalog.example.test/mf-manifest.json";
  const remote = { alias: "catalog", name: "catalog", url };
  const { session } = provider;
  session.loaded = [localApp("portal", "/portal", { remotes: [remote] })];
  session.extraUrls = [url];
  let body = new Response("<!doctype html><title>App</title>");
  t.mock.method(globalThis, "fetch", async () => body.clone());
  const cycle = createProbeCycle(createLoopbackNet(), session.book);
  const input = {
    apps: [],
    links: [remoteLink("portal", remote)],
    extraManifestUrls: [url],
    checkTypes: false,
  };
  await cycle.start(input);

  const [portal, external] = session.nodes();
  const settingsFile = "/workspace/.vscode/settings.json";
  assert.equal(portal.children[0].kind, "noAnswer");
  assert.equal(external.kind, "noAnswer");
  assert.equal(external.manifest?.label, terms.invalidManifest);
  assert.deepEqual(
    session.problemDrafts(settingsFile).map(({ kind, severity }) => [kind, severity]),
    [
      ["noAnswer", "warning"],
      ["noAnswer", "warning"],
    ],
  );

  body = Response.json({
    id: "catalog",
    name: "catalog",
    metaData: { name: "catalog", type: "app", publicPath: "auto" },
    shared: [],
    remotes: [],
    exposes: [
      {
        id: "catalog:Button",
        name: "Button",
        path: "./Button",
        assets: { js: { sync: ["Button.js"], async: [] }, css: { sync: [], async: [] } },
      },
    ],
  });
  await cycle.start(input);
  const [connected, reachable] = session.nodes();
  assert.equal(connected.children[0].kind, "answers");
  assert.equal(reachable.kind, "answers");
  assert.equal(reachable.manifest?.status, "answers");
  assert.deepEqual(session.problemDrafts(settingsFile), []);
});

test("Details suggests starting only the stopped dev server that provides the manifest", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-details-start-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configured = vscode.workspace.getConfiguration;
  t.mock.method(vscode.workspace, "getConfiguration", () => ({
    ...configured(),
    get: (key: string) => (key === "types.autoCheck" ? true : configured().get(key)),
  }));
  const provider = providerFor();
  t.after(() => provider.dispose());
  const remote = {
    alias: "catalog",
    name: "catalog",
    url: "http://127.0.0.1:4410/mf-manifest.json",
  };
  provider.session.loaded = [
    localApp("portal", root, { consumeTypes: true, remotes: [remote] }),
    localApp("catalog", root, { port: 4410 }),
  ];
  const probe = {
    portOpen: false,
    manifestReachable: false,
    buildVersion: null,
    zipUrl: null,
    zipMtime: null,
    zipHash: null,
    exposes: [],
    shared: [],
  };
  const linkId = linkRowId({ consumer: "portal", alias: "catalog", remoteName: "catalog" });
  putAppResult(provider.session.book, "catalog", probe);
  assert.equal(provider.typeDetails(linkId)?.archiveMatch, "missing");
  assert.equal(provider.typeDetails(linkId)?.startToCheck, true);

  remote.url = "https://staging.example/mf-manifest.json";
  assert.equal(provider.typeDetails(linkId)?.startToCheck, undefined);
  remote.url = "http://127.0.0.1:4410/another-manifest.json";
  assert.equal(provider.typeDetails(linkId)?.startToCheck, undefined);
  remote.url = "http://127.0.0.1:4410/mf-manifest.json";
  putAppResult(provider.session.book, "catalog", { ...probe, portOpen: true });
  assert.equal(provider.typeDetails(linkId)?.startToCheck, undefined);
});

function countBuilds(provider: Provider): { count: number } {
  const state = { count: 0 };
  const original = provider.session.nodes.bind(provider.session);
  provider.session.nodes = () => {
    state.count += 1;
    return original();
  };
  return state;
}

test("queue diagnostics measure waiting without merging refresh requests", async (t) => {
  const events: { level: string; text: string }[] = [];
  const provider = providerFor(events);
  t.after(() => provider.dispose());
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const settings = { version: 1 };
  const versions: number[] = [];
  t.mock.method(provider.session, "refresh", async () => {
    versions.push(settings.version);
    if (versions.length === 1) await gate;
  });
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const first = provider.refresh("settings");
  await Promise.resolve();
  now = 100;
  const queued = Array.from({ length: 3 }, () => provider.refresh("settings"));
  assert.equal(new Set(queued).size, 3);
  settings.version = 2;
  now = 1600;
  release();
  await Promise.all([first, ...queued]);
  assert.deepEqual(versions, [1, 2, 2, 2]);
  assert.ok(
    events.some(
      ({ level, text }) => level === "warn" && /action.started .*queueMs=1500/.test(text),
    ),
  );
  await provider.refresh("settings");
  assert.deepEqual(versions, [1, 2, 2, 2, 2]);
});

test("a rejected refresh does not prevent subsequent refreshes", async (t) => {
  const provider = providerFor();
  t.after(() => provider.dispose());
  let fail = true;
  t.mock.method(provider.session, "refresh", async () => {
    if (fail) throw new Error("probe failed");
  });
  await assert.rejects(provider.refresh(), /probe failed/);
  fail = false;
  await provider.refresh();
});

function useWorkspace(
  root: string,
  apps: Record<string, { path: string; typesZipPath?: string }>,
  rebuildCommand?: string,
): () => void {
  const previous = {
    getConfiguration: vscode.workspace.getConfiguration,
    folders: workspace.workspaceFolders,
    file: workspace.workspaceFile,
  };
  workspace.workspaceFolders = [{ name: "workspace", uri: vscode.Uri.file(root) }];
  workspace.workspaceFile = null;
  vscode.workspace.getConfiguration = (() => ({
    async update() {},
    inspect(key: string) {
      if (key === "apps") return { workspaceValue: apps };
      return undefined;
    },
    get(key: string) {
      if (key === "structure") return "tree";
      if (key === "envMode") return "development";
      if (key === "commands.rebuildTypes") return rebuildCommand;
      return undefined;
    },
  })) as unknown as typeof vscode.workspace.getConfiguration;
  return () => {
    vscode.workspace.getConfiguration = previous.getConfiguration;
    workspace.workspaceFolders = previous.folders;
    workspace.workspaceFile = previous.file;
  };
}

function writeApp(folder: string, name: string, remotes: string): void {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(folder, "module-federation.config.ts"),
    `export default { name: ${JSON.stringify(name)}, remotes: { ${remotes} } };`,
  );
}

test("the dashboard and Rebuild All accept the same unambiguous renamed app", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-renamed-app-"));
  writeApp(path.join(root, "gallery"), "gallery", "");
  const restore = useWorkspace(root, {
    archive: { path: "gallery" },
    gallery: { path: "missing" },
  });
  const events: { level: string; text: string }[] = [];
  const provider = providerFor(events);
  t.after(() => {
    restore();
    provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await provider.refresh();
  assert.deepEqual(
    provider.getChildren().map((row) => row.name),
    ["gallery"],
  );
  const report = await provider.rebuildAll(() => {});
  assert.deepEqual(report?.skipped, [
    { app: "gallery", reason: "Could not read the microfrontend config" },
  ]);
  const text = (event: string) => events.find((entry) => entry.text.startsWith(event))?.text ?? "";
  assert.match(text("types.rebuild.all.resolve"), /durationMs=\d+/);
  assert.match(text("types.rebuild.all.completed"), /durationMs=\d+/);
  assert.match(text("types.rebuild.all.completed"), /skipped=1/);
});

test("Rebuild All logs a timed resolution failure and completes once", async (t) => {
  const restore = useWorkspace(os.tmpdir(), { gallery: { path: "." } });
  const events: { level: string; text: string }[] = [];
  const provider = providerFor(events);
  t.after(() => {
    provider.dispose();
    restore();
  });
  t.mock.method(KnownAppsWorker.prototype, "request", async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    throw new Error("worker unavailable");
  });
  await assert.rejects(
    provider.rebuildAll(() => {}),
    /worker unavailable/,
  );
  const resolution = events.find(({ text }) => text.startsWith("types.rebuild.all.resolve"));
  assert.equal(resolution?.level, "error");
  assert.match(resolution?.text ?? "", /reason=resolve-failed.*durationMs=\d+/);
  const completed = events.filter(({ text }) => text.startsWith("types.rebuild.all.completed"));
  assert.equal(completed.length, 1);
  assert.match(completed[0].text, /failed=0 reason=resolve-failed resolveMs=\d+/);
});

function writeTypesBuildFixture(appDir: string, root = appDir): string {
  fs.writeFileSync(path.join(appDir, "index.ts"), "export const value = 1;");
  fs.writeFileSync(
    path.join(appDir, "rebuild.cjs"),
    "require('node:fs').writeFileSync('types.zip', Buffer.from([0x50, 0x4b, 3, 4, 1]));",
  );
  const decoder = path.join(root, "node_modules", "adm-zip");
  fs.mkdirSync(decoder, { recursive: true });
  fs.writeFileSync(
    path.join(decoder, "index.js"),
    `
      module.exports = class {
        getEntries() { return [{ entryName: "index.d.ts" }]; }
        extractAllTo(dir) { require("node:fs").writeFileSync(require("node:path").join(dir, "index.d.ts"), "types"); }
      };`,
  );
  return `${shellQuote(process.execPath)} rebuild.cjs`;
}

test("Rebuild All counts current consumers in its summary without changing the generation report", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-current-consumer-log-"));
  const producer = path.join(root, "gallery");
  fs.mkdirSync(producer);
  fs.writeFileSync(
    path.join(producer, "rsbuild.config.ts"),
    `
    export default { server: { port: 4100 }, plugins: [pluginModuleFederation({
      name: "gallery", manifest: true, dts: true, exposes: { "./index": "./index.ts" }
    })] };`,
  );
  const consumer = path.join(root, "shell");
  fs.mkdirSync(consumer);
  fs.writeFileSync(
    path.join(consumer, "module-federation.config.ts"),
    `
    export default {
      name: "shell", dts: { generateTypes: false, consumeTypes: true },
      remotes: { gallery: "gallery@http://localhost:4100/mf-manifest.json" }
    };`,
  );
  const restore = useWorkspace(
    root,
    { gallery: { path: "gallery", typesZipPath: "types.zip" }, shell: { path: "shell" } },
    writeTypesBuildFixture(producer, root),
  );
  const events: { level: string; text: string }[] = [];
  const provider = providerFor(events);
  t.after(() => {
    restore();
    provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const first = await provider.rebuildAll(() => {});
  assert.deepEqual(first?.installed, [{ consumer: "shell", alias: "gallery" }]);
  assert.match(
    events.find(({ text }) => text.startsWith("types.rebuild.all.completed"))?.text ?? "",
    /rebuilt=1 installed=1 current=0 /,
  );
  events.length = 0;
  const second = await provider.rebuildAll(() => {});
  assert.deepEqual(second?.installed, []);
  assert.deepEqual(second?.current, []);
  assert.ok(
    events.some(
      ({ text }) =>
        text.startsWith("types.rebuild.all.app") && text.includes("app=shell status=current"),
    ),
  );
  assert.match(
    events.find(({ text }) => text.startsWith("types.rebuild.all.completed"))?.text ?? "",
    /rebuilt=1 installed=0 current=1 /,
  );
});

for (const phase of ["persist", "refresh"]) {
  test(`Rebuild All retains the result when ${phase} fails`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-rebuild-log-"));
    fs.writeFileSync(
      path.join(root, "module-federation.config.ts"),
      "export default { name: 'gallery', dts: true, exposes: { './index': './index.ts' } };",
    );
    const restore = useWorkspace(
      root,
      {
        gallery: { path: ".", typesZipPath: "types.zip" },
        missing: { path: "missing" },
      },
      writeTypesBuildFixture(root),
    );
    const events: { level: string; text: string }[] = [];
    const fail = () => {
      throw new Error(`${phase} unavailable`);
    };
    const provider = providerFor(events, phase === "persist" ? fail : undefined);
    t.after(() => {
      restore();
      provider.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    });
    if (phase === "refresh") t.mock.method(provider.session, "problemDrafts", fail);
    await assert.rejects(
      provider.rebuildAll(() => {}),
      new RegExp(`${phase} unavailable`),
    );
    const completed = events.filter(({ text }) => text.startsWith("types.rebuild.all.completed"));
    assert.equal(completed.length, 1);
    assert.match(
      completed[0].text,
      new RegExp(`rebuilt=1 installed=0 current=0 skipped=1 failed=0 reason=${phase}-failed`),
    );
    if (phase === "refresh") {
      assert.match(completed[0].text, /refreshMs=\d+/);
      assert.match(
        events.find(({ text }) => text.startsWith("types.rebuild.all.refresh"))?.text ?? "",
        /reason=refresh-failed/,
      );
    }
  });
}

test("saving an Rslib config can restore a hidden, configured federation helper", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-rslib-ownership-save-"));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  writeApp(path.join(root, "shared"), "legacy", "");
  const library = path.join(root, "library");
  fs.mkdirSync(library);
  const config = path.join(library, "rslib.config.ts");
  fs.writeFileSync(path.join(library, ".env"), "NODE_ENV=production\n");
  const source = `export default { lib: [{ format: 'esm' }] };`;
  fs.writeFileSync(config, source);
  const restore = useWorkspace(root, { legacy: { path: "shared" } });
  const provider = providerFor();
  t.after(() => {
    restore();
    provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await provider.refresh();
  assert.equal(provider.session.loaded[0]?.name, "legacy");
  fs.writeFileSync(config, `import '../shared/module-federation.config';\n${source}`);
  await provider.fileSaved(config);
  assert.equal(provider.session.loaded[0]?.name, "legacy");
  fs.writeFileSync(config, developmentFederationConfig("../shared/module-federation.config"));
  await provider.fileSaved(config);
  assert.equal(provider.session.loaded.length, 0);
  fs.writeFileSync(config, source);
  await provider.fileSaved(config);
  assert.equal(provider.session.loaded[0]?.name, "legacy");
});

test("a successful refresh builds the tree once for logs and later row requests", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-tree-render-"));
  const shell = path.join(root, "shell");
  writeApp(shell, "shell", 'widget: "widget"');
  const events: { level: string; text: string }[] = [];
  const provider = providerFor(events);
  const restore = useWorkspace(root, { retired: { path: "shell" }, shell: { path: "shell" } });
  const builds = countBuilds(provider);
  t.after(() => {
    restore();
    provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await provider.refresh();
  const roots = provider.getChildren();
  const child = roots[0]?.children[0];
  assert.ok(child);
  provider.getChildren(child);
  provider.getChildren();
  assert.equal(builds.count, 1);
  assert.deepEqual(
    roots.map((row) => [row.name, row.kind, row.description]),
    [["shell", "unknownPort", "port unknown"]],
  );
  assert.deepEqual(provider.getTreeItem(roots[0]).iconPath, new vscode.ThemeIcon("question"));
  assert.deepEqual(
    [child.name, child.kind, child.description],
    ["widget", "invalidUrl", "URL error"],
  );
  assert.deepEqual(provider.session.problemDrafts(null), [
    {
      file: path.join(shell, "module-federation.config.ts"),
      message: "shell → widget: URL error",
      severity: "warning",
      kind: "invalidUrl",
    },
  ]);
  const statusEvents = () => events.filter((event) => event.text.includes("status.changed"));
  assert.equal(statusEvents().length, 2);
  const after = statusEvents().length;
  provider.getChildren();
  provider.getChildren(child);
  assert.equal(statusEvents().length, after);
  assert.equal(provider.getChildren(), roots);
  const stat = t.mock.method(fs, "statSync");
  const read = t.mock.method(fs, "readFileSync");
  const statBefore = stat.mock.callCount();
  const readBefore = read.mock.callCount();
  const built = builds.count;
  provider.getChildren();
  provider.getChildren(child);
  assert.equal(builds.count, built);
  assert.equal(read.mock.callCount(), readBefore);
  assert.equal(stat.mock.callCount() - statBefore, 2);
});

test("flat row reads skip hidden remote types paths and tree mode sees their changes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-tree-flat-"));
  const folder = path.join(root, "shell");
  const typesRoot = path.join(folder, "@mf-types");
  fs.mkdirSync(typesRoot, { recursive: true });
  const provider = providerFor();
  provider.session.loaded = [
    localApp("shell", folder, {
      remotes: [{ alias: "widget", name: "widget", url: null }],
    }),
  ];
  t.after(() => {
    provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  provider.setStructure("flat");
  const rows = provider.getChildren();
  assert.equal(rows[0]?.children.length, 0);
  fs.mkdirSync(path.join(typesRoot, "widget"));
  const stat = t.mock.method(fs, "statSync");
  assert.equal(provider.getChildren(), rows);
  assert.deepEqual(
    stat.mock.calls.map((call) => call.arguments[0]),
    [typesRoot],
  );
  provider.setStructure("tree");
  const link = provider.getChildren()[0]?.children[0];
  assert.ok(link);
  assert.ok(link.contextValue.split(" ").includes("types"));
});

test("language, structure, pending, and script gaps rebuild the visible rows", () => {
  const provider = providerFor();
  provider.session.loaded = [
    localApp("shell", "/shell", {
      port: null,
      remotes: [{ alias: "widget", name: "widget", url: null }],
    }),
    localApp("widget", "/widget", { port: null }),
  ];
  const first = provider.getChildren();
  assert.equal(first[0]?.children.length, 1);
  const quiet: DashboardTerms = { ...terms, unknownPort: "UNKNOWN PORT", invalidUrl: "BAD" };
  provider.relabel(quiet);
  assert.equal(provider.getChildren()[0]?.description, "UNKNOWN PORT");
  assert.equal(provider.getChildren()[0]?.children[0]?.description, "BAD · UNKNOWN PORT");
  provider.setStructure("flat");
  assert.equal(provider.getChildren()[0]?.children.length, 0);
  provider.setStructure("tree");
  const linkId = linkRowId({ consumer: "shell", alias: "widget", remoteName: "widget" });
  provider.session.failRefetch(linkId);
  assert.match(provider.getChildren()[0]?.children[0]?.tooltip ?? "", /types download failed/);
  assert.equal(provider.session.refetch(linkId), true);
  assert.equal(
    provider.getChildren()[0]?.children[0]?.tooltip.includes("types download failed"),
    false,
  );
  provider.session.releaseRefetch(linkId);
  provider.session.noteScriptMissing("shell");
  assert.match(provider.getChildren()[0]?.tooltip ?? "", /script not found/);
  provider.session.noteRebuildError("shell", "rebuild failed");
  assert.match(provider.getChildren()[0]?.tooltip ?? "", /rebuild failed/);
  const widget = provider.session.loaded.find((app) => app.name === "widget");
  assert.ok(widget);
  widget.port = 4100;
  putAppResult(provider.session.book, "widget", {
    portOpen: true,
    manifestReachable: false,
    buildVersion: null,
    zipUrl: null,
    zipMtime: null,
    zipHash: null,
    exposes: [],
    shared: [],
  });
  provider.session.typesForLink = () => "unfetched";
  const pendingId = linkRowId({ consumer: "shell", alias: "widget", remoteName: "widget" });
  assert.equal(provider.session.refetch(pendingId), true);
  assert.match(provider.getChildren()[0]?.children[0]?.contextValue ?? "", /unfetched\.pending/);
  provider.session.releaseRefetch(pendingId);
  assert.equal(provider.getChildren()[0]?.children[0]?.contextValue.includes("pending"), false);
  provider.dispose();
});

test("a types directory change updates Reveal types without a new probe", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-tree-types-"));
  const folder = path.join(root, "shell");
  fs.mkdirSync(folder);
  const provider = providerFor();
  const builds = countBuilds(provider);
  provider.session.loaded = [
    localApp("shell", folder, {
      remotes: [{ alias: "widget", name: "widget", url: null }],
    }),
  ];
  const typesRoot = path.join(folder, "@mf-types");
  const linkTypes = path.join(typesRoot, "widget");
  const hasTypes = (rowIndex: 0 | 1) => {
    const row = provider.getChildren()[0];
    const node = rowIndex === 0 ? row : row?.children[0];
    return node?.contextValue.split(" ").includes("types") ?? false;
  };
  try {
    assert.equal(hasTypes(0), false);
    assert.equal(hasTypes(1), false);
    const built = builds.count;
    fs.writeFileSync(typesRoot, "not a directory");
    assert.equal(hasTypes(0), false);
    fs.rmSync(typesRoot);
    fs.mkdirSync(typesRoot);
    assert.equal(hasTypes(0), true);
    assert.equal(hasTypes(1), false);
    fs.mkdirSync(linkTypes);
    assert.equal(hasTypes(1), true);
    fs.rmSync(linkTypes, { recursive: true });
    assert.equal(hasTypes(1), false);
    fs.rmSync(typesRoot, { recursive: true });
    assert.equal(hasTypes(0), false);
    assert.ok(builds.count > built);
    const warm = builds.count;
    provider.getChildren();
    provider.getChildren();
    assert.equal(builds.count, warm);
  } finally {
    provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace events update Reveal types in cached rows when a types directory appears or disappears", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-tree-watch-types-"));
  const folder = path.join(root, "shell");
  fs.mkdirSync(folder);
  const restore = useWorkspace(root, {});
  const creates = new vscode.EventEmitter<vscode.Uri>();
  const changes = new vscode.EventEmitter<vscode.Uri>();
  const deletes = new vscode.EventEmitter<vscode.Uri>();
  const dispose = t.mock.fn(() => {
    creates.dispose();
    changes.dispose();
    deletes.dispose();
  });
  const watch = t.mock.method(vscode.workspace, "createFileSystemWatcher", () => ({
    onDidCreate: creates.event,
    onDidDelete: deletes.event,
    onDidChange: changes.event,
    dispose,
  }));
  const provider = providerFor();
  t.after(() => {
    provider.dispose();
    restore();
    fs.rmSync(root, { recursive: true, force: true });
  });
  provider.session.loaded = [
    localApp("shell", folder, {
      typesFolder: "generated/types",
      remotes: [{ alias: "@team/widget", name: "widget", url: null }],
    }),
  ];
  provider.relabel();
  assert.match(String(watch.mock.calls[0].arguments[0]), /types/);
  const appId = provider.getChildren()[0].id;
  const hasTypes = () =>
    provider.findRow(appId)?.children[0]?.contextValue.split(" ").includes("types");
  const changed = t.mock.fn();
  provider.onDidChangeTreeData(changed);

  const target = path.join(folder, "generated", "types", "@team", "widget");
  fs.mkdirSync(target, { recursive: true });
  creates.fire(vscode.Uri.file(path.join(root, "widget")));
  await Promise.resolve();
  assert.equal(changed.mock.callCount(), 0);
  assert.equal(hasTypes(), false);
  creates.fire(vscode.Uri.file(path.join(folder, "generated")));
  creates.fire(vscode.Uri.file(target));
  await Promise.resolve();
  assert.equal(changed.mock.callCount(), 1);
  assert.equal(hasTypes(), true);
  assert.equal(watch.mock.callCount(), 1);

  fs.rmdirSync(target);
  fs.writeFileSync(target, "replaced the directory");
  changes.fire(vscode.Uri.file(target));
  await Promise.resolve();
  assert.equal(changed.mock.callCount(), 2);
  assert.equal(hasTypes(), false);
  fs.rmSync(target);
  fs.mkdirSync(target);
  changes.fire(vscode.Uri.file(target));
  await Promise.resolve();
  assert.equal(changed.mock.callCount(), 3);
  assert.equal(hasTypes(), true);

  fs.rmSync(path.join(folder, "generated"), { recursive: true });
  deletes.fire(vscode.Uri.file(path.join(folder, "generated")));
  await Promise.resolve();
  assert.equal(changed.mock.callCount(), 4);
  assert.equal(hasTypes(), false);
  provider.dispose();
  assert.equal(dispose.mock.callCount(), 1);
});

test("types watches follow internal links, including a chain whose final directory disappears", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-tree-watch-link-"));
  const restore = useWorkspace(root, {});
  const creates = new vscode.EventEmitter<vscode.Uri>();
  const changes = new vscode.EventEmitter<vscode.Uri>();
  const deletes = new vscode.EventEmitter<vscode.Uri>();
  const watch = t.mock.method(vscode.workspace, "createFileSystemWatcher", () => ({
    onDidCreate: creates.event,
    onDidChange: changes.event,
    onDidDelete: deletes.event,
    dispose() {},
  }));
  const provider = providerFor();
  t.after(() => {
    provider.dispose();
    restore();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const link = path.join(root, "generated");
  const first = path.join(root, "backing");
  const redirect = path.join(root, "redirect");
  const second = path.join(root, "replacement");
  fs.mkdirSync(first);
  fs.symlinkSync(first, link, "junction");
  provider.session.loaded = [localApp("shell", root, { typesFolder: "generated/types" })];
  provider.relabel();
  const hasTypes = () => provider.findRow("app:shell")?.contextValue.split(" ").includes("types");
  assert.match(String(watch.mock.calls.at(-1)?.arguments[0]), /backing/);
  assert.equal(hasTypes(), false);

  fs.mkdirSync(path.join(first, "types"));
  creates.fire(vscode.Uri.file(path.join(first, "types")));
  await Promise.resolve();
  assert.equal(hasTypes(), true);

  fs.mkdirSync(path.join(second, "types"), { recursive: true });
  fs.symlinkSync(second, redirect, "junction");
  fs.unlinkSync(link);
  fs.symlinkSync(redirect, link, "junction");
  changes.fire(vscode.Uri.file(link));
  await Promise.resolve();
  assert.match(String(watch.mock.calls.at(-1)?.arguments[0]), /replacement/);
  assert.equal(hasTypes(), true);

  fs.rmSync(second, { recursive: true });
  deletes.fire(vscode.Uri.file(second));
  await Promise.resolve();
  assert.equal(hasTypes(), false);
  assert.match(String(watch.mock.calls.at(-1)?.arguments[0]), /replacement/);
  fs.mkdirSync(second);
  creates.fire(vscode.Uri.file(second));
  await Promise.resolve();
  fs.mkdirSync(path.join(second, "types"));
  creates.fire(vscode.Uri.file(path.join(second, "types")));
  await Promise.resolve();
  assert.equal(hasTypes(), true);
});

test("moving an extra URL to user settings clears the old diagnostic without rebuilding rows", async (t) => {
  const root = os.tmpdir();
  const restore = useWorkspace(root, {});
  let workspaceValue = true;
  const url = "invalid URL";
  t.mock.method(vscode.workspace, "getConfiguration", () => ({
    async update() {},
    inspect: (key: string) =>
      key === "extraManifestUrls" && workspaceValue ? { workspaceValue: [url] } : undefined,
    get: (key: string) =>
      key === "probeIntervalMs" ? 0 : key === "extraManifestUrls" ? [url] : undefined,
  }));
  const provider = providerFor();
  t.after(() => {
    provider.dispose();
    restore();
  });
  const diagnostics = t.mock.method(provider["diagnostics"], "set");
  await provider.refresh("settings");
  const file = vscode.Uri.file(path.join(root, ".vscode", "settings.json"));
  const entries = diagnostics.mock.calls[0]?.arguments[0];
  assert.deepEqual(entries[0]?.[0], file);
  assert.ok(entries[0]?.[1]);

  const builds = countBuilds(provider);
  workspaceValue = false;
  await provider.refresh("settings");
  assert.deepEqual(diagnostics.mock.calls[1]?.arguments[0], [[file, undefined]]);
  assert.equal(builds.count, 0);
});

test("a refresh finishing after disposal leaves the diagnostic collection alone", async (t) => {
  const root = os.tmpdir();
  const restore = useWorkspace(root, {});
  const url = "invalid URL";
  t.mock.method(vscode.workspace, "getConfiguration", () => ({
    async update() {},
    inspect: (key: string) => (key === "extraManifestUrls" ? { workspaceValue: [url] } : undefined),
    get: (key: string) => (key === "extraManifestUrls" ? [url] : undefined),
  }));
  const provider = providerFor();
  t.after(restore);
  t.mock.method(provider.session["ports"], "probe", async () => {
    provider.dispose();
  });
  const diagnostics = t.mock.method(provider["diagnostics"], "set");
  await provider.refresh("settings");
  assert.equal(diagnostics.mock.callCount(), 0);
});

test("a failed refresh keeps the previous rows", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-tree-rollback-"));
  const shell = path.join(root, "shell");
  const other = path.join(root, "other");
  writeApp(shell, "shell", "");
  writeApp(other, "other", "");
  const provider = providerFor();
  const restore = useWorkspace(root, { shell: { path: "shell" } });
  t.after(() => {
    restore();
    provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await provider.refresh();
  assert.equal(provider.getChildren()[0]?.name, "shell");
  restore();
  t.after(useWorkspace(root, { other: { path: "other" } }));
  t.mock.method(provider.session["ports"], "probe", async () => {
    throw new Error("probe failed");
  });
  await assert.rejects(() => provider.refresh(), /probe failed/);
  assert.equal(provider.getChildren()[0]?.name, "shell");
  assert.equal(provider.session.loaded.length, 1);
});

test("saving a source and settling leave unchanged rows intact", async (t) => {
  const configured = vscode.workspace.getConfiguration;
  t.mock.method(vscode.workspace, "getConfiguration", () => ({
    ...configured(),
    get: (key: string) => (key === "types.autoCheck" ? true : configured().get(key)),
  }));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-tree-save-"));
  const folder = path.join(root, "shell");
  fs.mkdirSync(folder);
  const source = path.join(folder, "index.ts");
  fs.writeFileSync(source, "export const value = 1;\n");
  const provider = providerFor();
  const builds = countBuilds(provider);
  provider.session.loaded = [localApp("shell", folder, { tsconfig: null })];
  t.after(() => {
    provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  provider.getChildren();
  const baseline = builds.count;
  await provider.fileSaved(source);
  provider.getChildren();
  assert.equal(builds.count, baseline);
  t.mock.timers.tick(15_000);
  await provider["run"](async () => {});
  provider.getChildren();
  assert.equal(builds.count, baseline);
});

test("a structure change during a probe updates the rows without logging staged status", () => {
  const events: { level: string; text: string }[] = [];
  const provider = providerFor(events);
  provider.session.loaded = [
    localApp("shell", "/shell", {
      port: null,
      remotes: [{ alias: "widget", name: "widget", url: null }],
    }),
  ];
  provider.getChildren();
  const before = events.filter((event) => event.text.includes("status.changed")).length;
  provider.session.probeRunning = true;
  provider.setStructure("flat");
  assert.equal(provider.getChildren()[0]?.children.length, 0);
  assert.equal(events.filter((event) => event.text.includes("status.changed")).length, before);
  provider.session.probeRunning = false;
  provider.dispose();
});

test("logging off stays quiet across a rebuild and a repeated read", () => {
  const events: string[] = [];
  const provider = new MfDashboardProvider(
    () => terms,
    undefined,
    undefined,
    createLogger({
      enabled: () => false,
      write: (_level, text) => events.push(text),
    }),
  );
  provider.session.loaded = [localApp("shell", "/shell", { port: null })];
  provider.relabel(terms);
  provider.getChildren();
  provider.relabel(terms);
  assert.deepEqual(events, []);
  provider.dispose();
});

test("a shared link logs one status change when the same remote is reached through a cycle", () => {
  const events: { level: string; text: string }[] = [];
  const provider = providerFor(events);
  provider.session.loaded = [
    localApp("shell", "/shell", {
      remotes: [{ alias: "widget", name: "widget", url: null }],
    }),
    localApp("widget", "/widget", {
      remotes: [{ alias: "shell", name: "shell", url: null }],
    }),
  ];
  provider.relabel(terms);
  const changes = events.filter((event) => event.text.includes("status.changed"));
  const aliases = changes.map((event) => event.text.match(/alias=([^\s]+)/)?.[1] ?? "");
  assert.deepEqual(aliases.filter((alias) => alias !== "").sort(), ["shell", "widget"]);
  const again = changes.length;
  provider.relabel(terms);
  provider.getChildren();
  assert.equal(events.filter((event) => event.text.includes("status.changed")).length, again);
  provider.dispose();
});
