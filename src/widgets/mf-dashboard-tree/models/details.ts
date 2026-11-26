import {
  commands,
  env,
  Uri,
  window,
  type Disposable,
  type TreeView,
  type WebviewView,
  type WebviewViewProvider,
} from "vscode";
import {
  appPortIsOpen,
  remoteLinkKey,
  type LocalApp,
} from "../../../entities/microfrontend/index.ts";
import type { DashboardTerms } from "../../../shared/config/index.ts";
import { escapeHtml } from "../../../shared/lib/html.ts";
import { localManifestUrl } from "../../../shared/lib/urls.ts";
import { linksOf, parseLinkId } from "../lib/links.ts";
import type { DashboardNode } from "./presentation.ts";
import type { MfDashboardProvider } from "./provider.ts";

const OPEN_CONSUMER = "mf-dashboard.openConsumerDetails";
const COPY_URL = "mf-dashboard.copyManifestUrl";
const OPEN_APP = "mf-dashboard.details.openApp";
const RUN_CONNECTION_ACTION = "mf-dashboard.details.runConnectionAction";
const LINK_ICON = "M6.5 5H5a3 3 0 0 0 0 6h1.5M9.5 5H11a3 3 0 0 1 0 6H9.5M5.5 8h5";
const connectionActions = [
  { token: "config", command: "openConfig" },
  { token: "producer", command: "openProducerConfig" },
  { token: "manifest", command: "openManifest" },
  { token: "types", command: "revealTypes" },
] as const;

type TypeCheck = {
  name: string;
  observation: NonNullable<ReturnType<MfDashboardProvider["typeDetails"]>>;
};

export class DashboardDetails implements WebviewViewProvider {
  private readonly provider: MfDashboardProvider;
  private readonly subscriptions: Disposable[];
  private selectedId: string | undefined;
  private activeView: { render(): void; dispose(): void } | undefined;

  constructor(tree: TreeView<DashboardNode>, provider: MfDashboardProvider) {
    this.provider = provider;
    this.selectedId = tree.selection[0]?.id;
    // Refreshing a collapsed tree can empty tree.selection without a selection event.
    this.subscriptions = [
      tree.onDidChangeSelection(({ selection }) => {
        this.selectedId = selection[0]?.id;
        this.activeView?.render();
      }),
      commands.registerCommand(OPEN_CONSUMER, (name: unknown) => {
        const node = typeof name === "string" ? provider.findAppRow(name) : undefined;
        if (node) return tree.reveal(node, { select: true });
      }),
      commands.registerCommand(COPY_URL, async (id: unknown) => {
        const url = typeof id === "string" ? provider.findRow(id)?.manifest?.url : undefined;
        if (!url) return;
        await env.clipboard.writeText(url);
        window.setStatusBarMessage(provider.session.terms.urlCopied, 2000);
      }),
      commands.registerCommand(RUN_CONNECTION_ACTION, (id: unknown, action: unknown) => {
        const row = typeof id === "string" ? provider.findRow(id) : undefined;
        if (!row || row.id !== this.selectedId) return;
        const entry = connectionActions.find(({ command }) => command === action);
        if (entry && canRunAction(row, entry)) {
          return commands.executeCommand(`mf-dashboard.${entry.command}`, row);
        }
      }),
      commands.registerCommand(OPEN_APP, (id: unknown) => {
        if (typeof id !== "string" || id !== this.selectedId) return;
        const url = this.appUrl(this.appForRow(provider.findRow(id)));
        if (url) return env.openExternal(Uri.parse(url));
      }),
    ];
  }

  resolveWebviewView(view: WebviewView): void {
    this.activeView?.dispose();
    view.webview.options = {
      localResourceRoots: [],
      enableCommandUris: [OPEN_CONSUMER, COPY_URL, RUN_CONNECTION_ACTION, OPEN_APP],
    };
    let previousHtml: string | undefined;
    const render = () => {
      if (!view.visible) return;
      const { loaded, terms } = this.provider.session;
      const row =
        this.selectedId === undefined ? undefined : this.provider.findRow(this.selectedId);
      const app = this.appForRow(row);
      const types = row?.linkId ? this.provider.typeDetails(row.linkId) : undefined;
      const dependencies = app?.consumeTypes
        ? linksOf([app]).flatMap((link): TypeCheck[] => {
            const observation = this.provider.typeDetails(remoteLinkKey(link));
            const { remoteName, alias } = link;
            const name = remoteName === alias ? remoteName : `${remoteName} (${alias})`;
            return observation ? [{ name, observation }] : [];
          })
        : [];
      const consumers =
        row && (row.linkId || row.id === `app:${row.name}`)
          ? [
              ...new Set(
                loaded
                  .filter((app) => app.remotes.some((remote) => remote.name === row.name))
                  .map((app) => app.name),
              ),
            ].sort()
          : [];
      const html = detailsHtml(row, terms, types, dependencies, consumers, this.appUrl(app));
      if (html !== previousHtml) {
        view.webview.html = html;
        previousHtml = html;
      }
    };
    const subscriptions = [
      this.provider.onDidChangeTreeData(render),
      view.onDidChangeVisibility(render),
      view.onDidDispose(() => this.activeView?.dispose()),
    ];
    this.activeView = {
      render,
      dispose: () => {
        this.activeView = undefined;
        for (const subscription of subscriptions) subscription.dispose();
      },
    };
    render();
  }

  private appForRow(row: DashboardNode | undefined): LocalApp | undefined {
    if (!row || (!row.linkId && row.id !== `app:${row.name}`)) return;
    return this.provider.session.loaded.find(({ name }) => name === row.name);
  }

  private appUrl(app: LocalApp | undefined): string | undefined {
    const { book } = this.provider.session;
    if (app?.port != null && appPortIsOpen(book, app.name)) return localManifestUrl(app.port, "/");
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.activeView?.dispose();
  }
}

function propertyHtml(label: string, value: string): string {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;
}

function propertiesHtml(fields: readonly (readonly [string, string])[], actions = ""): string {
  if (fields.length === 0 && !actions) return "";
  return `<dl class="properties">${fields.map(([label, value]) => propertyHtml(label, escapeHtml(value))).join("")}${actions}</dl>`;
}

function commandUri(command: string, ...values: string[]): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify(values))}`;
}

function icon(path: string): string {
  return `<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;
}

function navigationLink(href: string, label: string): string {
  return `<a class="navigation-link" href="${href}" title="${escapeHtml(label)}">${icon(LINK_ICON)}<span>${escapeHtml(label)}</span></a>`;
}

function iconAction(href: string, label: string, path: string): string {
  const text = escapeHtml(label);
  return `<a class="icon-action" href="${href}" aria-label="${text}" title="${text}">${icon(path)}</a>`;
}

function canRunAction(row: DashboardNode, action: (typeof connectionActions)[number]): boolean {
  return (
    row.contextValue.split(" ").includes(action.token) &&
    (action.command !== "openManifest" || row.manifest?.status === "answers")
  );
}

function connectionActionsRow(row: DashboardNode, terms: DashboardTerms): string {
  const actions = connectionActions.filter((action) => canRunAction(row, action));
  if (actions.length === 0) return "";
  const links = actions.map(({ command }) => {
    const href = commandUri(RUN_CONNECTION_ACTION, row.id, command);
    return `<li>${navigationLink(href, terms[command])}</li>`;
  });
  return propertyHtml(terms.actions, `<ul class="connection-actions">${links.join("")}</ul>`);
}

function manifestRow(row: DashboardNode, terms: DashboardTerms): string {
  const manifest = row.manifest;
  if (!manifest) return "";
  const paths = {
    answers: "M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM5 8l2 2 4-4",
    noAnswer: "M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM6 6l4 4m0-4-4 4",
    checking: "M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM8 4.5V8l2 1.5",
    unchecked:
      "M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM6.5 6a1.5 1.5 0 1 1 2.6 1L8 8v1m0 2v.1",
  };
  const label = escapeHtml(manifest.label);
  const indicator = `<span class="url-status ${manifest.status}" role="img" aria-label="${label}" title="${label}">${icon(paths[manifest.status])}</span>`;
  if (!manifest.url) return propertyHtml(terms.url, `${indicator} ${label}`);
  const copy = iconAction(
    commandUri(COPY_URL, row.id),
    terms.copyUrl,
    "M5.5 5.5h8v8h-8zM3 10.5V3h7.5",
  );
  const open =
    manifest.status === "answers" && row.contextValue.split(" ").includes("manifest")
      ? iconAction(
          commandUri(RUN_CONNECTION_ACTION, row.id, "openManifest"),
          terms.openManifest,
          LINK_ICON,
        )
      : "";
  return propertyHtml(
    terms.url,
    `<div class="url-value">${indicator}<span>${escapeHtml(manifest.url)}</span>${copy}${open}</div>`,
  );
}

function typesTable(checks: readonly TypeCheck[], terms: DashboardTerms): string {
  if (checks.length === 0) return "";
  const archiveLabels = {
    matches: terms.typesMatchZip,
    differs: terms.typesDifferFromZip,
    missing: terms.typesMissing,
    unknown: terms.typesZipComparisonUnknown,
  };
  const sourceLabels = {
    fresh: terms.typesZipFresh,
    stale: terms.typesZipStale,
    unknown: terms.typesZipFreshnessUnknown,
  };
  const rows = checks.map(({ name, observation }) => {
    const missing = observation.archiveMatch === "missing";
    const changed = observation.status === "changed";
    const archiveLabel = changed ? terms.typesChanged : archiveLabels[observation.archiveMatch];
    const hint =
      observation.startToCheck && !missing && !changed
        ? terms.startToCheckTypes
        : observation.status === "none"
          ? terms.typesDisabled
          : observation.status === "unchecked"
            ? terms.typesUnchecked
            : "";
    const result = hint
      ? `<td colspan="2"${observation.startToCheck ? ' class="start-hint"' : ""}>${escapeHtml(hint)}</td>`
      : `<td>${escapeHtml(archiveLabel)}</td><td${observation.startToCheck ? ' class="start-hint"' : ""}>${escapeHtml(observation.startToCheck ? terms.startToCheckTypes : sourceLabels[observation.sourceFreshness])}</td>`;
    return `<tr><th scope="row">${escapeHtml(name)}</th>${result}</tr>`;
  });
  const headings = [terms.dependency, terms.serverComparison, terms.sourceCheck];
  return `<table class="types-table"><thead><tr>${headings.map((label) => `<th scope="col">${escapeHtml(label)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function detailsHtml(
  row: DashboardNode | undefined,
  terms: DashboardTerms,
  types: ReturnType<MfDashboardProvider["typeDetails"]>,
  dependencies: readonly TypeCheck[],
  consumers: readonly string[],
  appUrl: string | undefined,
): string {
  const empty = terms.selectForDetails;
  const status = row ? terms[row.kind] : "";
  const connection = row?.linkId ? parseLinkId(row.linkId) : null;
  const connectionFields: [string, string][] = row ? [[terms.appStatus, status]] : [];
  const manifestFields: [string, string][] = [];
  const typeFields: [string, string][] = [];
  const notes: string[] = [];
  for (const line of row?.tooltip.split("\n") ?? []) {
    if (
      !line.trim() ||
      line === status ||
      line === row?.manifest?.label ||
      line === terms.typesChanged ||
      line === terms.treeReference
    )
      continue;
    const separator = line.indexOf(": ");
    const label = separator < 0 ? "" : line.slice(0, separator);
    const value = line.slice(separator + 2);
    if (label === terms.url && row?.manifest) continue;
    if ([terms.folder, terms.localPort, terms.url, terms.link].includes(label)) {
      connectionFields.push([label, value]);
    } else if (label === terms.exposes || label === terms.shared) {
      manifestFields.push([label, value]);
    } else if (label === terms.typesCheckedAt) {
      typeFields.push([label, value]);
    } else {
      notes.push(line);
    }
  }
  const incomingTypes =
    row && types ? typesTable([{ name: row.name, observation: types }], terms) : "";
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${row ? escapeHtml(row.name) : escapeHtml(empty)}</title>
  <style>
    body {
      margin: 0;
      padding: 10px 12px 14px;
      font: var(--vscode-font-size) / 1.5 var(--vscode-font-family);
      color: var(--vscode-sideBar-foreground, var(--vscode-foreground));
      background: var(--vscode-sideBar-background);
      overflow-wrap: anywhere;
    }
    header { display: flex; align-items: center; gap: 6px; }
    header .icon-action { flex: none; }
    h1 { font-size: 1.2em; margin: 0; overflow-wrap: anywhere; }
    h2 { font-size: 1.04em; font-weight: 600; margin: 0; }
    #manifest-title::first-letter, dt::first-letter { text-transform: uppercase; }
    p { margin: 0; }
    .context, dt, .empty { color: var(--vscode-descriptionForeground); }
    section {
      margin-top: 12px;
      padding-top: 10px;
      display: grid;
      gap: 6px;
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
    }
    .properties { margin: 0; }
    .properties > div {
      display: grid;
      grid-template-columns: clamp(7em, 37%, 11em) minmax(0, 1fr);
      gap: 2px 10px;
      padding: 3px 6px;
    }
    .properties > div:nth-child(odd), .types-table tbody tr:nth-child(odd) {
      background: color-mix(in srgb, currentColor 5%, transparent);
    }
    dd { margin: 0; font-variant-numeric: tabular-nums; }
    .types-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    .types-table :is(th, td) { padding: 3px 6px; text-align: start; vertical-align: top; }
    .types-table thead th { color: var(--vscode-descriptionForeground); font-weight: 500; }
    .types-table thead th:first-child { width: 26%; }
    .types-table tbody th { font-weight: 400; }
    .types-table td[colspan]::first-letter { text-transform: uppercase; }
    .start-hint { border-inline-start: 2px solid var(--vscode-focusBorder); }
    .types-status > .context { margin-top: 4px; }
    .notes { white-space: pre-wrap; }
    .consumers, .connection-actions { list-style: none; margin: 0; padding: 0; }
    .navigation-link, .icon-action {
      color: inherit;
      text-decoration: none;
    }
    .navigation-link {
      display: flex;
      align-items: flex-start;
      gap: 7px;
      padding-block: 2px;
    }
    .navigation-link:hover span { text-decoration: underline; }
    svg { width: 1.2em; height: 1.2em; vertical-align: -0.18em; }
    .navigation-link svg { flex: none; height: 1lh; }
    .url-value > :is(.url-status, .icon-action) { flex: none; }
    .url-value { display: flex; align-items: flex-start; gap: 5px; }
    .url-value > span:not(.url-status) { min-width: 0; }
    .url-status { color: var(--vscode-descriptionForeground); }
    .url-status.answers { color: var(--vscode-testing-iconPassed, var(--vscode-foreground)); }
    .url-status.noAnswer { color: var(--vscode-editorError-foreground, var(--vscode-foreground)); }
    .icon-action { display: inline-flex; padding: 2px; border-radius: 3px; }
    .icon-action:hover { background: var(--vscode-toolbar-hoverBackground); }
    a:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
    @media (max-width: 250px) {
      .properties > div { grid-template-columns: minmax(0, 1fr); }
    }
  </style>
</head>
<body>
  <main>${
    row
      ? `<header><h1>${escapeHtml(row.name)}</h1>${
          appUrl
            ? iconAction(
                commandUri(OPEN_APP, row.id),
                `${terms.openMicrofrontend} (${appUrl})`,
                "M9 2.5h4.5V7M13.5 2.5 7 9M6 3.5H3v9.5h9.5V10",
              )
            : ""
        }</header>
<section aria-labelledby="connection-title">
  <h2 id="connection-title">${escapeHtml(terms.connectionDetails)}</h2>
  ${propertiesHtml(connectionFields, manifestRow(row, terms) + connectionActionsRow(row, terms))}
  ${notes.length ? `<p class="notes">${escapeHtml(notes.join("\n"))}</p>` : ""}
</section>
${
  manifestFields.length
    ? `<section aria-labelledby="manifest-title">
  <h2 id="manifest-title">${escapeHtml(terms.manifest)}</h2>
  ${propertiesHtml(manifestFields)}
</section>`
    : ""
}
${
  consumers.length
    ? `<section aria-labelledby="consumers-title">
  <h2 id="consumers-title">${escapeHtml(terms.consumers)}</h2>
  <ul class="consumers">${consumers.map((name) => `<li>${navigationLink(commandUri(OPEN_CONSUMER, name), name)}</li>`).join("")}</ul>
</section>`
    : ""
}
${
  dependencies.length || incomingTypes || typeFields.length
    ? `<section class="types-status" aria-labelledby="types-title">
  <h2 id="types-title">@mf-types</h2>
  ${typesTable(dependencies, terms)}
  ${
    incomingTypes && connection
      ? `<p class="context">${escapeHtml(`${terms.typeCheckFor} ${connection.consumer}`)}</p>`
      : ""
  }
  ${incomingTypes}
  ${propertiesHtml(typeFields)}
</section>`
    : ""
}`
      : `<p class="empty">${escapeHtml(empty)}</p>`
  }</main>
</body>
</html>`;
}
