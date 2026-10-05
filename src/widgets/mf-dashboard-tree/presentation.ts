import {
  appProbeId,
  externalManifestId,
  linkProbeId,
  manifestTooltipLines,
  type LocalApp,
  type RemoteLink,
  type ProbeBook,
  type ManifestModules,
} from "../../entities/microfrontend/index.ts";
import {
  classify,
  problemDraft,
  rowModel,
  type ProblemDraft,
  type StatusInput,
  type StatusKind,
} from "../../entities/status/index.ts";
import type { DashboardTerms } from "../../shared/config/index.ts";
import { withActionTokens, type RowAction } from "./targets.ts";

export type DashboardStructure = "flat" | "tree";

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

export interface DashboardView {
  readonly loaded: readonly LocalApp[];
  readonly extraUrls: readonly string[];
  readonly structure: DashboardStructure;
  readonly terms: DashboardTerms;
  readonly book: ProbeBook;
  readonly pending: ReadonlySet<string>;
  readonly refetchErrors: ReadonlySet<string>;
  readonly scriptGaps: ReadonlySet<string>;
  readonly rebuildErrors: ReadonlyMap<string, string>;
  typesForLink(link: RemoteLink): StatusInput["typesState"];
  actionFor(node: unknown): RowAction | null;
}

export function linkRowId(link: Pick<RemoteLink, "consumer" | "alias" | "remoteName">): string {
  return `${link.consumer}\0${link.alias}\0${link.remoteName}`;
}

export function rowContextValue(kind: string, pending: boolean): string {
  if (pending && kind === "unfetched") return "unfetched.pending";
  return kind;
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

export function dashboardNodes(view: DashboardView): DashboardNode[] {
  const byName = new Map(view.loaded.map((item) => [item.name, item]));
  const roots = rootApps(view, byName).map((item) => appNode(view, item, byName, new Set()));
  for (const url of view.extraUrls) roots.push(extraNode(view, url));
  return roots;
}

export function dashboardProblemDrafts(
  view: DashboardView,
  settingsFile: string | null,
): ProblemDraft[] {
  const drafts: ProblemDraft[] = [];
  const byName = new Map(view.loaded.map((item) => [item.name, item]));
  for (const app of view.loaded) {
    for (const remote of app.remotes) {
      const kind = classify(linkStatusInput(view, app, remote, byName));
      const draft = problemDraft({
        kind,
        surface: "link",
        owner: app.name,
        alias: remote.alias,
        label: view.terms[kind],
        file: app.configFile,
      });
      if (draft) drafts.push(draft);
    }
  }
  for (const url of view.extraUrls) {
    const kind = classify(extraStatusInput(view, url));
    const draft = problemDraft({
      kind,
      surface: "extra",
      owner: hostLabel(url),
      alias: null,
      label: view.terms[kind],
      file: settingsFile,
    });
    if (draft) drafts.push(draft);
  }
  return drafts;
}

function rootApps(view: DashboardView, byName: Map<string, LocalApp>): LocalApp[] {
  const sorted = [...view.loaded].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  if (view.structure === "flat") return sorted;
  const consumed = new Set<string>();
  for (const app of view.loaded) {
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

function appNode(
  view: DashboardView,
  app: LocalApp,
  byName: Map<string, LocalApp>,
  stack: ReadonlySet<string>,
): DashboardNode {
  const probe = view.book.apps.get(appProbeId(app.name));
  const row = model(
    view,
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
    contextValue: withActionTokens(
      row.contextValue,
      view.actionFor({ id: `app:${app.name}`, name: app.name, linkId: null })?.tokens ?? [],
    ),
    linkId: null,
    children:
      view.structure === "flat"
        ? []
        : app.remotes.map((remote) =>
            linkNode(view, app, remote, byName, new Set(stack).add(app.name), [`app:${app.name}`]),
          ),
  };
}

function linkStatusInput(
  view: DashboardView,
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
      portOpen: view.book.apps.get(appProbeId(producer.name))?.portOpen ?? false,
      manifestEnabled: producer.manifest,
      buildVersion: view.book.apps.get(appProbeId(producer.name))?.buildVersion ?? null,
      requestFailure: view.book.links.get(linkProbeId(link))?.requestFailure,
      url: remote.url,
      typesState: view.typesForLink(link),
    };
  }
  return {
    role: "external",
    port: null,
    portOpen: view.book.links.get(linkProbeId(link))?.manifestReachable ?? false,
    manifestEnabled: true,
    buildVersion: view.book.links.get(linkProbeId(link))?.buildVersion ?? null,
    requestFailure: view.book.links.get(linkProbeId(link))?.requestFailure,
    url: remote.url,
    typesState: "none",
  };
}

function extraStatusInput(view: DashboardView, url: string): StatusInput {
  const result = view.book.extras.get(externalManifestId(url));
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

function linkNode(
  view: DashboardView,
  parent: LocalApp,
  remote: LocalApp["remotes"][number],
  byName: Map<string, LocalApp>,
  stack: ReadonlySet<string>,
  parentPath: readonly string[],
): DashboardNode {
  const link: RemoteLink = {
    consumer: parent.name,
    alias: remote.alias,
    remoteName: remote.name,
    url: remote.url,
  };
  const linkProbe = view.book.links.get(linkProbeId(link));
  const status = linkStatusInput(view, parent, remote, byName);
  const producer = byName.get(remote.name);
  const input: StatusInput & { folder?: string } =
    producer !== undefined && producer.port !== null
      ? { ...status, folder: producer.folder }
      : status;
  const linkId = linkRowId(link);
  const row = model(view, input, view.pending.has(linkId), linkId, remote.name, {
    exposes: linkProbe?.exposes ?? [],
    shared: linkProbe?.shared ?? [],
  });
  const nodePath = [...parentPath, linkId];
  const id = JSON.stringify(nodePath);
  const nested =
    producer !== undefined && producer.port !== null && !stack.has(producer.name)
      ? producer.remotes.map((child) =>
          linkNode(view, producer, child, byName, new Set(stack).add(producer.name), nodePath),
        )
      : [];
  return {
    id,
    name: remote.name,
    ...row,
    contextValue: withActionTokens(
      row.contextValue,
      view.actionFor({ id, name: remote.name, linkId })?.tokens ?? [],
    ),
    linkId,
    children: nested,
  };
}

function extraNode(view: DashboardView, url: string): DashboardNode {
  const result = view.book.extras.get(externalManifestId(url));
  const input: StatusInput = extraStatusInput(view, url);
  const row = model(view, input, false, null, hostLabel(url), {
    exposes: result?.exposes ?? [],
    shared: result?.shared ?? [],
  });
  return {
    id: `extra:${url}`,
    name: hostLabel(url),
    ...row,
    contextValue: withActionTokens(
      row.contextValue,
      view.actionFor({ id: `extra:${url}`, name: hostLabel(url), linkId: null })?.tokens ?? [],
    ),
    linkId: null,
    children: [],
  };
}

function model(
  view: DashboardView,
  input: StatusInput & { folder?: string },
  pending: boolean,
  linkId: string | null,
  name: string,
  modules: ManifestModules = { exposes: [], shared: [] },
): Pick<DashboardNode, "kind" | "description" | "tooltip" | "contextValue"> {
  const row = rowModel(input, view.terms);
  const contextValue = rowContextValue(row.kind, pending);
  let tooltip = row.tooltip;
  if (input.role === "external" && !input.folder)
    tooltip = `${view.terms.folder}: ${view.terms.noWorkspace}\n${tooltip}`;
  if (input.role === "link" && input.typesState === "unknown")
    tooltip = `${tooltip}\n${view.terms.typesUnknown}`;
  if (input.role === "link" && input.typesState === "none")
    tooltip = `${tooltip}\n${view.terms.typesDisabled}`;
  if (contextValue === "unfetched.pending") tooltip = `${tooltip}\n${view.terms.refetchPending}`;
  if (linkId && view.refetchErrors.has(linkId)) tooltip = `${tooltip}\n${view.terms.refetchFailed}`;
  if (view.scriptGaps.has(name)) tooltip = `${tooltip}\n${view.terms.scriptMissing}`;
  const rebuildError = view.rebuildErrors.get(name);
  if (rebuildError) tooltip = `${tooltip}\n${rebuildError}`;
  for (const line of manifestTooltipLines(modules, view.terms)) tooltip = `${tooltip}\n${line}`;
  return { kind: row.kind, description: row.description, tooltip, contextValue };
}
