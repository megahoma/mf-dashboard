import fs from "node:fs";
import path from "node:path";
import {
  createProbeBook,
  readAppFolder,
  type ArtifactProbe,
  type LinkProbeResult,
  type LocalApp,
  type ProbeBook,
  type ProbeCycleInput,
  type ProbeResult,
  type RemoteLink,
  type ScanOptions,
} from "../../entities/microfrontend/index.ts";
import { type ProblemDraft, type StatusInput } from "../../entities/status/index.ts";
import { mergeMissingApps } from "../../features/init-settings/index.ts";
import { terms, type DashboardTerms } from "../../shared/config/index.ts";
import { resolveRowAction } from "./targets.ts";
import {
  dashboardNodes,
  dashboardProblemDrafts,
  type DashboardNode,
  type DashboardStructure,
} from "./presentation.ts";
export { linkRowId, rowContextValue } from "./presentation.ts";
export type { DashboardNode, DashboardStructure } from "./presentation.ts";

export interface AppSetting {
  path: string;
  workspaceFolder?: string;
  manifestPath?: string;
  scripts?: { start?: string };
}

export interface WorkspaceRoot {
  name: string;
  path: string;
}

export interface DashboardSettings {
  apps: Record<string, AppSetting> | undefined;
  envMode: string;
  ignorePaths: readonly string[];
  extraManifestUrls: readonly string[];
  structure: DashboardStructure;
}

export interface DashboardPorts {
  readSettings(): DashboardSettings;
  writeApps(apps: Record<string, AppSetting>): void | Promise<void>;
  scan(root: string, options: ScanOptions): Record<string, LocalApp>;
  loadKnown(
    roots: readonly WorkspaceRoot[],
    apps: Record<string, AppSetting>,
    envMode: string,
    ignorePaths: readonly string[],
    cache?: AppParseCache,
  ): LocalApp[];
  probe(book: ProbeBook, input: ProbeCycleInput): Promise<void>;
  roots(): WorkspaceRoot[];
}

export function beginRefetch(pending: Set<string>, linkId: string): boolean {
  if (pending.has(linkId)) return false;
  pending.add(linkId);
  return true;
}

export function endRefetch(pending: Set<string>, linkId: string): void {
  pending.delete(linkId);
}

export function savedFileKind(
  app: Pick<LocalApp, "folder" | "configFile" | "generateTypes">,
  file: string,
  envMode: string,
): "config" | "source" | null {
  const folder = path.resolve(app.folder);
  const full = path.resolve(file);
  const relative = path.relative(folder, full);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return null;
  if (full === path.resolve(app.configFile)) return "config";
  if (path.dirname(full) === folder) {
    const name = path.basename(full);
    if (/^(module-federation|webpack|rspack|rsbuild|vite)\.config\./.test(name)) return "config";
    if (name === `.env.${envMode}` || name === `.env.${envMode}.local`) return "config";
  }
  return app.generateTypes && /\.tsx?$/.test(full) && !full.endsWith(".d.ts") ? "source" : null;
}

export interface AppParseCache {
  lookup(key: string, folder: string, envMode: string): LocalApp | null;
  store(
    key: string,
    folder: string,
    envMode: string,
    app: LocalApp,
    dependencies?: readonly string[],
  ): void;
}

export function appConfigStamp(
  folder: string,
  envMode: string,
  configFile: string | null,
  dependencies: readonly string[] = [],
): string {
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(folder)
      .filter((name) => /^(module-federation|webpack|rspack|rsbuild|vite)\.config\./.test(name))
      .sort();
  } catch {
    /* A removed folder invalidates its cached parse. */
  }
  const files = [
    ...names.map((name) => path.join(folder, name)),
    path.join(folder, `.env.${envMode}`),
    path.join(folder, `.env.${envMode}.local`),
    ...dependencies,
  ];
  if (configFile) files.push(configFile);
  return [...new Set(files)]
    .sort()
    .map((file) => {
      try {
        const stat = fs.statSync(file);
        return `${file}\0${fs.realpathSync(file)}\0${stat.size}\0${stat.mtimeMs}`;
      } catch {
        return `${file}\0missing`;
      }
    })
    .join("\n");
}

export function createAppParseCache(): AppParseCache {
  const stored = new Map<
    string,
    { stamp: string; app: LocalApp; dependencies: readonly string[] }
  >();
  return {
    lookup(key, folder, envMode) {
      const hit = stored.get(key);
      if (
        !hit ||
        hit.stamp !== appConfigStamp(folder, envMode, hit.app.configFile, hit.dependencies)
      )
        return null;
      return hit.app;
    },
    store(key, folder, envMode, app, dependencies = []) {
      stored.set(key, {
        stamp: appConfigStamp(folder, envMode, app.configFile, dependencies),
        app,
        dependencies: [...dependencies],
      });
    },
  };
}

export function loadKnownApps(
  roots: readonly WorkspaceRoot[],
  apps: Record<string, AppSetting>,
  envMode: string,
  _ignorePaths: readonly string[] = [],
  cache: AppParseCache = createAppParseCache(),
): LocalApp[] {
  const loaded: LocalApp[] = [];
  for (const [name, setting] of Object.entries(apps)) {
    if (!setting || typeof setting.path !== "string" || setting.path.trim() === "") continue;
    const candidates = setting.workspaceFolder
      ? roots.filter((root) => root.name === setting.workspaceFolder)
      : roots;
    let fallback: LocalApp | undefined;
    let matched = false;
    for (const root of candidates) {
      const abs = confinedAppPath(root.path, setting.path);
      if (!abs) continue;
      const key = `${root.path}\0${abs}\0${envMode}\0${name}`;
      const cached = cache.lookup(key, abs, envMode);
      const dependencies = new Set<string>();
      const match = cached ?? readAppFolder(abs, envMode, name, dependencies);
      if (!match) continue;
      if (!cached) cache.store(key, abs, envMode, match, [...dependencies]);
      fallback ??= match;
      if (match.name !== name) continue;
      const manifestPath =
        typeof setting.manifestPath === "string" && setting.manifestPath !== ""
          ? setting.manifestPath
          : match.manifestPath;
      loaded.push({ ...match, manifestPath });
      matched = true;
      break;
    }
    if (!matched && fallback && candidates.length === 1) {
      loaded.push({
        ...fallback,
        manifestPath: setting.manifestPath || fallback.manifestPath,
      });
    }
  }
  return loaded;
}

function pathInsideRoot(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

function confinedAppPath(root: string, settingPath: string): string | null {
  const base = path.resolve(root);
  const abs = path.resolve(base, settingPath);
  if (!pathInsideRoot(base, abs)) return null;
  try {
    if (!fs.existsSync(abs)) return abs;
    if (!pathInsideRoot(fs.realpathSync(base), fs.realpathSync(abs))) return null;
  } catch {
    return null;
  }
  return abs;
}

function workspaceRelative(root: string, folder: string): string {
  const relative = path.relative(root, folder);
  if (relative === "") return ".";
  return relative.split(path.sep).join("/");
}

function linksOf(apps: readonly LocalApp[]): RemoteLink[] {
  const links: RemoteLink[] = [];
  for (const app of apps) {
    for (const remote of app.remotes) {
      links.push({
        consumer: app.name,
        alias: remote.alias,
        remoteName: remote.name,
        url: remote.url,
      });
    }
  }
  return links;
}

export class DashboardSession {
  loaded: LocalApp[] = [];
  extraUrls: string[] = [];
  structure: DashboardStructure = "tree";
  terms: DashboardTerms = terms;
  typesForLink: (link: RemoteLink) => StatusInput["typesState"] = () => "unknown";
  beforeRefreshChange: () => void = () => {};
  onRefreshFailed: () => void = () => {};
  probeRunning = false;
  readonly pending = new Set<string>();
  readonly refetchErrors = new Set<string>();
  readonly scriptGaps = new Set<string>();
  readonly rebuildErrors = new Map<string, string>();
  private readonly ports: DashboardPorts;
  private readonly appCache = createAppParseCache();
  readonly book: ProbeBook;
  private readonly onChange: () => void;

  constructor(ports: DashboardPorts, book: ProbeBook, onChange: () => void = () => {}) {
    this.ports = ports;
    this.book = book;
    this.onChange = onChange;
  }

  async refresh(): Promise<void> {
    const snapshot = this.captureRefreshState();
    this.probeRunning = true;
    let structureAtProbe = this.structure;
    try {
      const current = this.ports.readSettings();
      const roots = this.ports.roots();
      const extraUrls = [...current.extraManifestUrls];
      // A flat/tree toggle during the probe updates this.structure in place.
      this.structure = current.structure === "flat" ? "flat" : "tree";
      structureAtProbe = this.structure;
      const loaded =
        roots.length === 0 || current.apps === undefined
          ? []
          : this.ports.loadKnown(
              roots,
              current.apps,
              current.envMode,
              current.ignorePaths,
              this.appCache,
            );
      const names = new Set<string>();
      for (const app of loaded) {
        if (names.has(app.name)) throw new Error(`duplicate federation name: ${app.name}`);
        names.add(app.name);
      }
      // The probe writes `staged`. The visible book stays put until the swap below.
      const staged = createProbeBook();
      staged.zips = new Map(this.book.zips);
      await this.ports.probe(staged, {
        apps: loaded,
        links: linksOf(loaded),
        extraManifestUrls: extraUrls,
      });
      this.applyRefreshState({
        apps: staged.apps,
        links: staged.links,
        extras: staged.extras,
        loaded,
        extraUrls,
        structure: this.structure,
      });
      this.book.zips.clear();
      for (const [url, fact] of staged.zips) this.book.zips.set(url, fact);
    } catch (error) {
      const toggledDuringProbe = this.structure !== structureAtProbe;
      this.applyRefreshState({
        ...snapshot,
        structure: toggledDuringProbe ? this.structure : snapshot.structure,
      });
      this.probeRunning = false;
      this.onRefreshFailed();
      if (toggledDuringProbe) this.onChange();
      throw error;
    }
    this.probeRunning = false;
    this.beforeRefreshChange();
    this.onChange();
  }

  async discover(): Promise<void> {
    const current = this.ports.readSettings();
    const roots = this.ports.roots();
    if (roots.length > 0) {
      if (new Set(roots.map((root) => root.name)).size !== roots.length)
        throw new Error("workspace folder names must be unique");
      const foundApps: Record<string, AppSetting> = {};
      for (const root of roots) {
        const found = this.ports.scan(root.path, {
          envMode: current.envMode,
          ignorePaths: current.ignorePaths,
        });
        for (const [name, foundApp] of Object.entries(found)) {
          if (foundApps[name]) throw new Error(`duplicate federation name: ${name}`);
          foundApps[name] = {
            path: workspaceRelative(root.path, foundApp.folder),
            ...(roots.length > 1 ? { workspaceFolder: root.name } : {}),
            manifestPath: foundApp.manifestPath,
            scripts: { start: "dev" },
          };
        }
      }
      const apps = mergeMissingApps(current.apps, foundApps);
      const changed = Object.keys(foundApps).some((name) => current.apps?.[name] == null);
      if (changed) await this.ports.writeApps(apps);
    }
    await this.refresh();
  }

  relabel(next: DashboardTerms): void {
    this.terms = next;
    this.onChange();
  }

  setStructure(next: DashboardStructure): void {
    const structure = next === "flat" ? "flat" : "tree";
    if (this.structure === structure) return;
    this.structure = structure;
    this.onChange();
  }

  refetch(linkId: string): boolean {
    const accepted = beginRefetch(this.pending, linkId);
    if (accepted) {
      this.refetchErrors.delete(linkId);
      this.onChange();
    }
    return accepted;
  }

  releaseRefetch(linkId: string): void {
    endRefetch(this.pending, linkId);
    this.onChange();
  }

  failRefetch(linkId: string): void {
    this.refetchErrors.add(linkId);
    endRefetch(this.pending, linkId);
    this.onChange();
  }

  noteScriptMissing(name: string): void {
    this.scriptGaps.add(name);
    this.onChange();
  }

  clearScriptMissing(name: string): void {
    if (this.scriptGaps.delete(name)) this.onChange();
  }

  noteRebuildError(name: string, message: string): void {
    this.rebuildErrors.set(name, message);
    this.onChange();
  }

  clearRebuildError(name: string): void {
    if (!this.rebuildErrors.delete(name)) return;
    this.onChange();
  }

  private captureRefreshState(): {
    apps: Map<string, ProbeResult>;
    links: Map<string, LinkProbeResult>;
    extras: Map<string, ArtifactProbe>;
    loaded: LocalApp[];
    extraUrls: string[];
    structure: DashboardStructure;
  } {
    return {
      apps: new Map(this.book.apps),
      links: new Map(this.book.links),
      extras: new Map(this.book.extras),
      loaded: this.loaded,
      extraUrls: [...this.extraUrls],
      structure: this.structure,
    };
  }

  private applyRefreshState(snapshot: {
    apps: Map<string, ProbeResult>;
    links: Map<string, LinkProbeResult>;
    extras: Map<string, ArtifactProbe>;
    loaded: LocalApp[];
    extraUrls: string[];
    structure: DashboardStructure;
  }): void {
    this.book.apps.clear();
    for (const [key, value] of snapshot.apps) this.book.apps.set(key, value);
    this.book.links.clear();
    for (const [key, value] of snapshot.links) this.book.links.set(key, value);
    this.book.extras.clear();
    for (const [key, value] of snapshot.extras) this.book.extras.set(key, value);
    this.loaded = snapshot.loaded;
    this.extraUrls = snapshot.extraUrls;
    this.structure = snapshot.structure;
  }

  actionFor(node: unknown) {
    return resolveRowAction(node, this.loaded, this.extraUrls);
  }

  nodes(): DashboardNode[] {
    return dashboardNodes(this);
  }

  problemDrafts(settingsFile: string | null): ProblemDraft[] {
    return dashboardProblemDrafts(this, settingsFile);
  }
}
