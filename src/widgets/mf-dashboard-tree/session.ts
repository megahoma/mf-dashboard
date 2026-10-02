import fs from "node:fs";
import path from "node:path";
import {
  appProbeId,
  externalManifestId,
  linkProbeId,
  manifestTooltipLines,
  scanWorkspace,
  type ArtifactProbe,
  type LinkProbeResult,
  type LocalApp,
  type ManifestModules,
  type ProbeBook,
  type ProbeCycleInput,
  type ProbeResult,
  type RemoteLink,
  type ScanOptions,
} from "../../entities/microfrontend/index.ts";
import {
  classify,
  problemDraft,
  rowModel,
  type ProblemDraft,
  type StatusInput,
  type StatusKind,
} from "../../entities/status/index.ts";
import { mergeMissingApps } from "../../features/init-settings/index.ts";
import { icons, terms, type DashboardTerms } from "../../shared/config/index.ts";

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

export type DashboardStructure = "flat" | "tree";

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
  ): LocalApp[];
  probe(input: ProbeCycleInput): Promise<void>;
  roots(): WorkspaceRoot[];
}

export interface DashboardNode {
  id: string;
  name: string;
  kind: StatusKind;
  description: string;
  tooltip: string;
  contextValue: string;
  children: DashboardNode[];
  linkId: string | null;
}

export function beginRefetch(pending: Set<string>, linkId: string): boolean {
  if (pending.has(linkId)) return false;
  pending.add(linkId);
  return true;
}

export function endRefetch(pending: Set<string>, linkId: string): void {
  pending.delete(linkId);
}

export function linkRowId(link: Pick<RemoteLink, "consumer" | "alias" | "remoteName">): string {
  return `${link.consumer}\0${link.alias}\0${link.remoteName}`;
}

export function rowContextValue(kind: string, pending: boolean): string {
  if (pending && kind === "unfetched") return "unfetched.pending";
  return kind;
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

export function presentRow(node: DashboardNode): {
  description: string;
  iconId: string;
  contextValue: string;
  tooltip: string;
} {
  return {
    description: node.description,
    iconId: icons[node.kind],
    contextValue: node.contextValue,
    tooltip: node.tooltip,
  };
}

export function loadKnownApps(
  roots: readonly WorkspaceRoot[],
  apps: Record<string, AppSetting>,
  envMode: string,
  ignorePaths: readonly string[] = [],
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
      const found = scanWorkspace(abs, { envMode, ignorePaths });
      const inFolder = Object.values(found).filter((item) => path.resolve(item.folder) === abs);
      const match = inFolder.find((item) => item.name === name);
      fallback ??= inFolder[0];
      if (!match) continue;
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

function hostLabel(url: string): string {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname !== "")
      return parsed.hostname;
  } catch {
    // Keep the raw value when the external address cannot be parsed.
  }
  return trimmed || "external";
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
    try {
      this.book.apps.clear();
      this.book.links.clear();
      this.book.extras.clear();
      const current = this.ports.readSettings();
      const roots = this.ports.roots();
      this.structure = current.structure === "flat" ? "flat" : "tree";
      this.extraUrls = [...current.extraManifestUrls];
      if (roots.length === 0 || current.apps === undefined) this.loaded = [];
      else
        this.loaded = this.ports.loadKnown(
          roots,
          current.apps,
          current.envMode,
          current.ignorePaths,
        );
      const names = new Set<string>();
      for (const app of this.loaded) {
        if (names.has(app.name)) throw new Error(`duplicate federation name: ${app.name}`);
        names.add(app.name);
      }
      await this.ports.probe({
        apps: this.loaded,
        links: linksOf(this.loaded),
        extraManifestUrls: this.extraUrls,
      });
    } catch (error) {
      this.restoreRefreshState(snapshot);
      this.probeRunning = false;
      this.onRefreshFailed();
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

  private restoreRefreshState(snapshot: {
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

  nodes(): DashboardNode[] {
    const byName = new Map(this.loaded.map((item) => [item.name, item]));
    const roots = this.rootApps(byName).map((item) => this.appNode(item, byName, new Set()));
    for (const url of this.extraUrls) roots.push(this.extraNode(url));
    return roots;
  }

  problemDrafts(settingsFile: string | null): ProblemDraft[] {
    const drafts: ProblemDraft[] = [];
    const byName = new Map(this.loaded.map((item) => [item.name, item]));
    for (const app of this.loaded) {
      for (const remote of app.remotes) {
        const kind = classify(this.linkStatusInput(app, remote, byName));
        const draft = problemDraft({
          kind,
          surface: "link",
          owner: app.name,
          alias: remote.alias,
          label: this.terms[kind],
          file: app.configFile,
        });
        if (draft) drafts.push(draft);
      }
    }
    for (const url of this.extraUrls) {
      const kind = classify(this.extraStatusInput(url));
      const draft = problemDraft({
        kind,
        surface: "extra",
        owner: hostLabel(url),
        alias: null,
        label: this.terms[kind],
        file: settingsFile,
      });
      if (draft) drafts.push(draft);
    }
    return drafts;
  }

  private rootApps(byName: Map<string, LocalApp>): LocalApp[] {
    const sorted = [...this.loaded].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    if (this.structure === "flat") return sorted;
    const consumed = new Set<string>();
    for (const app of this.loaded) {
      for (const remote of app.remotes) {
        if (byName.has(remote.name)) consumed.add(remote.name);
      }
    }
    const entries = sorted.filter((app) => !consumed.has(app.name));
    const reached = new Set<string>();
    const visit = (app: LocalApp): void => {
      if (reached.has(app.name)) return;
      reached.add(app.name);
      for (const remote of app.remotes) {
        const child = byName.get(remote.name);
        if (child) visit(child);
      }
    };
    for (const app of entries) visit(app);
    for (const app of sorted) {
      if (!reached.has(app.name)) {
        entries.push(app);
        visit(app);
      }
    }
    return entries;
  }

  private appNode(
    app: LocalApp,
    byName: Map<string, LocalApp>,
    stack: ReadonlySet<string>,
  ): DashboardNode {
    const probe = this.book.apps.get(appProbeId(app.name));
    const row = this.model(
      {
        role: "app",
        port: app.port,
        portOpen: probe?.portOpen ?? false,
        manifestEnabled: app.manifest,
        buildVersion: probe?.buildVersion ?? null,
        requestFailure: probe?.requestFailure,
        url: null,
        typesState: "none",
        folder: app.folder,
      },
      false,
      null,
      app.name,
      {
        exposes: probe?.exposes ?? [],
        shared: probe?.shared ?? [],
      },
    );
    return {
      id: `app:${app.name}`,
      name: app.name,
      ...row,
      linkId: null,
      children:
        this.structure === "flat"
          ? []
          : app.remotes.map((remote) =>
              this.linkNode(app, remote, byName, new Set(stack).add(app.name), `app:${app.name}`),
            ),
    };
  }

  private linkStatusInput(
    parent: LocalApp,
    remote: LocalApp["remotes"][number],
    byName: Map<string, LocalApp>,
  ): StatusInput {
    const link: RemoteLink = {
      consumer: parent.name,
      alias: remote.alias,
      remoteName: remote.name,
      url: remote.url,
    };
    const producer = byName.get(remote.name);
    const local = producer !== undefined && producer.port !== null;
    if (local) {
      return {
        role: "link",
        port: producer.port,
        portOpen: this.book.apps.get(appProbeId(producer.name))?.portOpen ?? false,
        manifestEnabled: producer.manifest,
        buildVersion: this.book.apps.get(appProbeId(producer.name))?.buildVersion ?? null,
        requestFailure: this.book.links.get(linkProbeId(link))?.requestFailure,
        url: remote.url,
        typesState: this.typesForLink(link),
      };
    }
    return {
      role: "external",
      port: null,
      portOpen: this.book.links.get(linkProbeId(link))?.manifestReachable ?? false,
      manifestEnabled: true,
      buildVersion: this.book.links.get(linkProbeId(link))?.buildVersion ?? null,
      requestFailure: this.book.links.get(linkProbeId(link))?.requestFailure,
      url: remote.url,
      typesState: "none",
    };
  }

  private extraStatusInput(url: string): StatusInput {
    const result = this.book.extras.get(externalManifestId(url));
    return {
      role: "external",
      port: null,
      portOpen: result?.manifestReachable ?? false,
      manifestEnabled: true,
      buildVersion: result?.buildVersion ?? null,
      requestFailure: result?.requestFailure,
      url,
      typesState: "none",
    };
  }

  private linkNode(
    parent: LocalApp,
    remote: LocalApp["remotes"][number],
    byName: Map<string, LocalApp>,
    stack: ReadonlySet<string>,
    parentId: string,
  ): DashboardNode {
    const link: RemoteLink = {
      consumer: parent.name,
      alias: remote.alias,
      remoteName: remote.name,
      url: remote.url,
    };
    const linkProbe = this.book.links.get(linkProbeId(link));
    const status = this.linkStatusInput(parent, remote, byName);
    const producer = byName.get(remote.name);
    const input: StatusInput & { folder?: string } =
      producer !== undefined && producer.port !== null
        ? { ...status, folder: producer.folder }
        : status;
    const linkId = linkRowId(link);
    const row = this.model(input, this.pending.has(linkId), linkId, remote.name, {
      exposes: linkProbe?.exposes ?? [],
      shared: linkProbe?.shared ?? [],
    });
    const id = JSON.stringify([parentId, linkId]);
    const nested =
      producer !== undefined && producer.port !== null && !stack.has(producer.name)
        ? producer.remotes.map((child) =>
            this.linkNode(producer, child, byName, new Set(stack).add(producer.name), id),
          )
        : [];
    return {
      id,
      name: remote.name,
      ...row,
      linkId,
      children: nested,
    };
  }

  private extraNode(url: string): DashboardNode {
    const result = this.book.extras.get(externalManifestId(url));
    const input: StatusInput = this.extraStatusInput(url);
    const row = this.model(input, false, null, hostLabel(url), {
      exposes: result?.exposes ?? [],
      shared: result?.shared ?? [],
    });
    return {
      id: `extra:${url}`,
      name: hostLabel(url),
      ...row,
      linkId: null,
      children: [],
    };
  }

  private model(
    input: StatusInput & { folder?: string },
    pending: boolean,
    linkId: string | null,
    name: string,
    modules: ManifestModules = { exposes: [], shared: [] },
  ): Pick<DashboardNode, "kind" | "description" | "tooltip" | "contextValue"> {
    const row = rowModel(input, this.terms);
    const contextValue = rowContextValue(row.kind, pending);
    let tooltip = row.tooltip;
    if (input.role === "external" && !input.folder)
      tooltip = `${this.terms.folder}: ${this.terms.noWorkspace}\n${tooltip}`;
    if (input.role === "link" && input.typesState === "unknown")
      tooltip = `${tooltip}\n${this.terms.typesUnknown}`;
    if (input.role === "link" && input.typesState === "none")
      tooltip = `${tooltip}\n${this.terms.typesDisabled}`;
    if (contextValue === "unfetched.pending") tooltip = `${tooltip}\n${this.terms.refetchPending}`;
    if (linkId && this.refetchErrors.has(linkId))
      tooltip = `${tooltip}\n${this.terms.refetchFailed}`;
    if (this.scriptGaps.has(name)) tooltip = `${tooltip}\n${this.terms.scriptMissing}`;
    const rebuildError = this.rebuildErrors.get(name);
    if (rebuildError) tooltip = `${tooltip}\n${rebuildError}`;
    for (const line of manifestTooltipLines(modules, this.terms)) tooltip = `${tooltip}\n${line}`;
    return { kind: row.kind, description: row.description, tooltip, contextValue };
  }
}
