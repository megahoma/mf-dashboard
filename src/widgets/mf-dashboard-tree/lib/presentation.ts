import {
  appProbeId,
  appsByName,
  rootApps,
  externalManifestId,
  linkProbeId,
  manifestTooltipLines,
  remoteLink,
  remoteLinkKey,
  type ArtifactProbe,
  type LocalApp,
} from "../../../entities/microfrontend/index.ts";
import {
  classify,
  problemDraft,
  rowModel,
  type ProblemDraft,
  type StatusInput,
} from "../../../entities/status/index.ts";
import { isHttpUrl, localManifestUrl } from "../../../shared/lib/urls.ts";
import type { DashboardNode, DashboardView } from "../models/presentation.ts";
import { withActionTokens } from "./targets.ts";

export { remoteLinkKey as linkRowId } from "../../../entities/microfrontend/index.ts";

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
  const byName = appsByName(view.loaded);
  const expanded = new Set<string>();
  const apps = rootApps(view.loaded, byName, view.structure);
  if (view.structure === "flat" && view.flatSort === "port") {
    const unknownPort = Number.MAX_SAFE_INTEGER;
    apps.sort((left, right) => (left.port ?? unknownPort) - (right.port ?? unknownPort));
  }
  const roots = apps.map((item) => appNode(view, item, byName, expanded));
  for (const url of view.extraUrls) roots.push(extraNode(view, url));
  return roots;
}

export function dashboardProblemDrafts(
  view: DashboardView,
  settingsFile: string | null,
): ProblemDraft[] {
  const drafts: ProblemDraft[] = [];
  const byName = appsByName(view.loaded);
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

function appNode(
  view: DashboardView,
  app: LocalApp,
  byName: Map<string, LocalApp>,
  expanded: Set<string>,
): DashboardNode {
  expanded.add(app.name);
  const probe = view.book.apps.get(appProbeId(app.name));
  const row = model(
    view,
    {
      role: "app",
      port: app.port,
      portOpen: probe?.portOpen ?? false,
      checking: view.probeRunning && !probe && app.port !== null,
      unchecked: view.manualProbeOnly && !probe && app.port !== null,
      manifestEnabled: app.manifest,
      buildVersion: probe?.buildVersion ?? null,
      requestFailure: probe?.requestFailure,
      url: app.manifest && app.port !== null ? localManifestUrl(app.port, app.manifestPath) : null,
      typesState: "none",
      folder: app.folder,
    },
    false,
    null,
    app.name,
    probe,
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
            linkNode(view, app, remote, byName, expanded, [`app:${app.name}`]),
          ),
  };
}

function manifestAnswers(probe: ArtifactProbe | undefined): boolean {
  return probe?.manifestReachable === true && probe.manifestValid !== false;
}

function linkStatusInput(
  view: DashboardView,
  parent: LocalApp,
  remote: LocalApp["remotes"][number],
  byName: Map<string, LocalApp>,
): StatusInput {
  const link = remoteLink(parent.name, remote);
  const producer = byName.get(remote.name);
  const probe = view.book.links.get(linkProbeId(link));
  const local = producer !== undefined && producer.port !== null;
  if (local) {
    const producerProbe = view.book.apps.get(appProbeId(producer.name));
    const checking = view.probeRunning && !producerProbe;
    return {
      role: "link",
      port: producer.port,
      portOpen: producerProbe?.portOpen ?? false,
      checking,
      unchecked: view.manualProbeOnly && !producerProbe,
      manifestEnabled: producer.manifest,
      buildVersion: producerProbe?.buildVersion ?? null,
      requestFailure: probe?.requestFailure,
      url: remote.url,
      typesState: checking ? "none" : view.typesForLink(link),
    };
  }
  return {
    role: "external",
    port: null,
    portOpen: manifestAnswers(probe),
    checking: view.probeRunning && !probe && remote.url !== null,
    unchecked: view.manualProbeOnly && !probe && isHttpUrl(remote.url),
    manifestEnabled: true,
    buildVersion: probe?.buildVersion ?? null,
    requestFailure: probe?.requestFailure,
    url: remote.url,
    typesState: "none",
  };
}

function extraStatusInput(view: DashboardView, url: string): StatusInput {
  const result = view.book.extras.get(externalManifestId(url));
  return {
    role: "external",
    port: null,
    portOpen: manifestAnswers(result),
    checking: view.probeRunning && !result,
    unchecked: view.manualProbeOnly && !result && isHttpUrl(url),
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
  expanded: Set<string>,
  parentPath: readonly string[],
): DashboardNode {
  const link = remoteLink(parent.name, remote);
  const linkProbe = view.book.links.get(linkProbeId(link));
  const status = linkStatusInput(view, parent, remote, byName);
  const producer = byName.get(remote.name);
  const input = producer ? { ...status, folder: producer.folder } : status;
  const linkId = remoteLinkKey(link);
  const row = model(view, input, view.pending.has(linkId), linkId, remote.name, linkProbe);
  if (producer?.port === null) {
    row.description += ` · ${view.terms.unknownPort}`;
    row.tooltip += `\n${view.terms.unknownPort}`;
  }
  const nodePath = [...parentPath, linkId];
  const id = JSON.stringify(nodePath);
  const nested: DashboardNode[] = [];
  if (producer !== undefined) {
    if (expanded.has(producer.name)) {
      row.tooltip += `\n${view.terms.treeReference}`;
    } else {
      expanded.add(producer.name);
      for (const child of producer.remotes)
        nested.push(linkNode(view, producer, child, byName, expanded, nodePath));
    }
  }
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
  const row = model(view, input, false, null, hostLabel(url), result);
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
  probe: ArtifactProbe | undefined,
): Pick<DashboardNode, "kind" | "description" | "tooltip" | "contextValue" | "manifest"> {
  const row = rowModel({ ...input, typesState: "none" }, view.terms);
  const contextValue = rowContextValue(classify(input), pending);
  let tooltip = row.tooltip;
  if (input.role === "external" && !input.folder)
    tooltip = `${view.terms.folder}: ${view.terms.noWorkspace}\n${tooltip}`;
  if (input.typesState === "changed") tooltip = `${tooltip}\n${view.terms.typesChanged}`;
  if (contextValue === "unfetched.pending") tooltip = `${tooltip}\n${view.terms.refetchPending}`;
  if (linkId && view.refetchErrors.has(linkId)) tooltip = `${tooltip}\n${view.terms.refetchFailed}`;
  if (view.scriptGaps.has(name)) tooltip = `${tooltip}\n${view.terms.scriptMissing}`;
  const rebuildError = view.rebuildErrors.get(name);
  if (rebuildError) tooltip = `${tooltip}\n${rebuildError}`;
  if (probe) {
    for (const line of manifestTooltipLines(probe, view.terms)) tooltip = `${tooltip}\n${line}`;
  }
  const { terms } = view;
  const urlIssue = row.urlIssue ?? (probe?.manifestValid === false ? terms.invalidManifest : null);
  const status =
    urlIssue || probe?.manifestReachable === false
      ? "noAnswer"
      : manifestAnswers(probe)
        ? "answers"
        : input.checking
          ? "checking"
          : "unchecked";
  const manifest =
    input.url || urlIssue
      ? ({
          url: input.url?.trim() || null,
          status,
          label: urlIssue ?? (status === "unchecked" ? terms.urlUnchecked : terms[status]),
        } as const)
      : undefined;
  return { kind: row.kind, description: row.description, tooltip, contextValue, manifest };
}
