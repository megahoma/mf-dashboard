import * as vscode from "vscode";
import { appsByName, rootApps, type LocalApp } from "../../entities/microfrontend/index.ts";
import { workspaceTypesPlan, type RebuildAppStatus } from "../../features/rebuild-types/index.ts";
import type { SourceProblem } from "../../shared/models/source-problem.ts";

export type TypesBuildSnapshot = {
  apps: RebuildAppStatus[];
  error?: string;
};

type AppTarget = Pick<RebuildAppStatus, "app" | "settingsKey">;
type AppRow = AppTarget & { id?: string; children?: AppRow[]; expandByDefault?: boolean };
type Row = AppRow | { label: string; text?: string; problem?: SourceProblem };
type Translate = (message: string, ...args: (string | number)[]) => string;

export const TYPES_BUILD_VIEW = "mf-dashboard.typesBuild";

function statusLabel(status: RebuildAppStatus["status"], t: Translate): string {
  switch (status) {
    case "queued":
      return t("Queued");
    case "running":
      return t("Updating");
    case "rebuilt":
      return t("Rebuilt");
    case "current":
      return t("No rebuild needed");
    case "installed":
      return t("Installed");
    case "skipped":
      return t("Skipped");
    case "failed":
      return t("Failed");
    case "not-applicable":
      return t("No types to update");
  }
}

const icons = {
  queued: "clock",
  running: "sync~spin",
  rebuilt: "check",
  current: "check",
  installed: "check",
  skipped: "warning",
  failed: "error",
  "not-applicable": "circle-slash",
} satisfies Record<RebuildAppStatus["status"], string>;

const buildTasks = {
  generate: { icon: "package", tooltip: "Generates @mf-types for exposed modules." },
  install: { icon: "arrow-down", tooltip: "Installs @mf-types from dependencies." },
  both: { icon: "arrow-swap", tooltip: "Installs dependency types and generates @mf-types." },
} as const;

function position(problem: SourceProblem): vscode.Range {
  const line = problem.line - 1;
  const start = problem.column - 1;
  return new vscode.Range(line, start, line, start + 1);
}

function appLabel(app: AppTarget): string {
  return app.settingsKey && app.settingsKey !== app.app
    ? `${app.app} (${app.settingsKey})`
    : app.app;
}

export class TypesBuildView implements vscode.TreeDataProvider<Row>, vscode.Disposable {
  private readonly change = new vscode.EventEmitter<AppRow[] | void>();
  readonly onDidChangeTreeData = this.change.event;
  private readonly diagnostics = vscode.languages.createDiagnosticCollection(
    "mf-dashboard-types-build",
  );
  private readonly apps = new Map<string, RebuildAppStatus>();
  private loaded: readonly LocalApp[] = [];
  private workspaceKey = "[]";
  private structure: "flat" | "tree" = "tree";
  private roots: AppRow[] = [];
  private workspaceApps = new Map<string, LocalApp>();
  private tasksByApp = new Map<string, keyof typeof buildTasks>();
  private readonly rowsByApp = new Map<string, AppRow[]>();
  private running = false;
  private error: string | undefined;
  private t: Translate;
  private onFirstRootRead?: () => void;

  constructor(
    previous?: TypesBuildSnapshot,
    t: Translate = vscode.l10n.t,
    onFirstRootRead?: () => void,
  ) {
    this.t = t;
    this.onFirstRootRead = onFirstRootRead;
    for (const app of previous?.apps ?? []) this.apps.set(app.settingsKey ?? app.app, app);
    this.error = previous?.error;
  }

  relabel(t: Translate): void {
    this.t = t;
    this.change.fire();
  }

  setWorkspace(loaded: readonly LocalApp[], structure: "flat" | "tree"): void {
    if (loaded === this.loaded && structure === this.structure) return;
    let topologyChanged = false;
    if (loaded !== this.loaded) {
      this.loaded = loaded;
      const key = JSON.stringify(
        loaded.map((app) => [
          app.name,
          app.settingsKey,
          app.generateTypes,
          app.consumeTypes,
          app.hasExposes,
          app.port,
          app.manifestPath,
          app.devManifestPath,
          app.remotes.map(({ name, alias, url }) => [name, alias, url]),
        ]),
      );
      topologyChanged = key !== this.workspaceKey;
      if (topologyChanged) {
        this.workspaceKey = key;
        this.workspaceApps = new Map(loaded.map((app) => [app.settingsKey ?? app.name, app]));
        this.tasksByApp = new Map(
          workspaceTypesPlan(loaded).order.map(({ app, generate, links }) => [
            app.name,
            generate ? (links.length ? "both" : "generate") : "install",
          ]),
        );
      }
    }
    if (!topologyChanged && structure === this.structure) return;
    this.structure = structure;
    const names = new Set<string>();
    const duplicates = new Set<string>();
    for (const { name } of loaded) {
      if (names.has(name)) duplicates.add(name);
      names.add(name);
    }
    const byName = appsByName(loaded.filter((app) => !duplicates.has(app.name)));
    this.rowsByApp.clear();
    const expanded = new Set<string>();
    const build = (app: LocalApp, parent?: string, alias?: string): AppRow => {
      const key = app.settingsKey ?? app.name;
      const children: AppRow[] = [];
      if (structure === "tree" && !expanded.has(key)) {
        expanded.add(key);
        for (const remote of app.remotes) {
          const child = byName.get(remote.name);
          if (child) children.push(build(child, key, remote.alias));
        }
      }
      const row = {
        app: app.name,
        settingsKey: app.settingsKey,
        children,
        expandByDefault: parent === undefined && children.length > 0,
        id:
          parent === undefined
            ? `types:${key}`
            : `types-link:${JSON.stringify([parent, alias, key])}`,
      };
      const rows = this.rowsByApp.get(key) ?? [];
      rows.push(row);
      this.rowsByApp.set(key, rows);
      return row;
    };
    this.roots = rootApps(loaded, byName, structure).map((app) => build(app));
    this.change.fire();
  }

  targetFor(row?: Row): AppTarget | undefined {
    if (!row || !("app" in row)) return;
    const app = this.workspaceApps.get(row.settingsKey ?? row.app);
    if (app?.name === row.app && this.tasksByApp.has(app.name))
      return { app: app.name, settingsKey: app.settingsKey };
  }

  start(target?: AppTarget): void {
    const wasStopped = this.error !== undefined;
    this.running = true;
    this.error = undefined;
    if (target) {
      this.update([{ ...target, status: "queued" }], wasStopped);
      return;
    }
    this.apps.clear();
    this.diagnostics.clear();
    this.change.fire();
  }

  reset(): void {
    if (!this.apps.size && !this.error && !this.running) return;
    this.running = false;
    this.error = undefined;
    this.apps.clear();
    this.diagnostics.clear();
    this.change.fire();
  }

  update(updates: readonly RebuildAppStatus[], rootsChanged = false): void {
    if (!updates.length) return;
    let changed = false;
    const rows: AppRow[] = [];
    for (const update of updates) {
      const key = update.settingsKey ?? update.app;
      const previous = this.apps.get(key);
      if (update.problems?.length || previous?.problems?.length) changed = true;
      const occurrences = this.rowsByApp.get(key);
      if (
        occurrences &&
        this.matchesResult(occurrences[0].app, update) &&
        (!previous || this.matchesResult(occurrences[0].app, previous))
      )
        rows.push(...occurrences);
      else rootsChanged = true;
      this.apps.set(key, update);
    }
    if (changed) this.publishProblems();
    this.change.fire(rootsChanged ? undefined : rows);
  }

  finish(error?: string): TypesBuildSnapshot {
    this.running = false;
    this.error = error;
    for (const [key, app] of this.apps) {
      if (app.status === "queued" || app.status === "running") {
        this.apps.set(key, { ...app, status: "skipped", reason: error });
      }
    }
    this.change.fire();
    return { apps: [...this.apps.values()], error };
  }

  getChildren(row?: Row): Row[] {
    if (!row) {
      if (this.loaded.length && this.onFirstRootRead) {
        this.onFirstRootRead();
        this.onFirstRootRead = undefined;
      }
      const apps = [...this.roots];
      for (const result of this.sortedApps()) {
        const key = result.settingsKey ?? result.app;
        const app = this.workspaceApps.get(key);
        if (!app) apps.push(result);
        else if (!this.matchesResult(app.name, result))
          apps.push({ ...result, id: `types-result:${key}` });
      }
      if (this.error)
        return [
          {
            label: this.t("Build stopped"),
            text: this.t("Could not update @mf-types: {0}", this.error),
          },
          ...apps,
        ];
      if (this.running && !apps.length) return [{ label: this.t("Preparing @mf-types build…") }];
      return apps;
    }
    if (!("app" in row)) return [];
    const result = this.resultFor(row);
    return [
      ...(result?.reason ? [{ label: result.reason.split("\n")[0], text: result.reason }] : []),
      ...(result?.problems ?? []).map((problem) => ({ label: problem.message, problem })),
      ...(result?.installed ?? []).map((alias) => ({
        label: this.t("Installed @mf-types for {0}", alias),
      })),
      ...(row.children ?? []),
    ];
  }

  getTreeItem(row: Row): vscode.TreeItem {
    if ("app" in row) {
      const result = this.resultFor(row);
      const target = this.targetFor(row);
      const task = target && this.tasksByApp.get(target.app);
      const planned = task && buildTasks[task];
      const label = appLabel(row);
      const item = new vscode.TreeItem(
        label,
        row.expandByDefault
          ? vscode.TreeItemCollapsibleState.Expanded
          : row.children?.length ||
              result?.reason ||
              result?.problems?.length ||
              result?.installed?.length
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None,
      );
      item.id = row.id ?? `types:${row.settingsKey ?? row.app}`;
      item.description = result ? statusLabel(result.status, this.t) : this.t("Not built yet");
      item.iconPath = new vscode.ThemeIcon(
        result ? icons[result.status] : (planned?.icon ?? icons["not-applicable"]),
      );
      item.tooltip =
        result?.reason ?? (!result ? this.t(planned?.tooltip ?? "No types to update") : undefined);
      item.accessibilityInformation = {
        label: [label, item.description, item.tooltip].filter(Boolean).join(", "),
      };
      if (target) item.contextValue = "typesBuildApp";
      return item;
    }
    const item = new vscode.TreeItem(row.label);
    item.tooltip = row.text;
    if (row.problem) {
      const { file, line, column, message, code } = row.problem;
      item.description = `${vscode.workspace.asRelativePath(file)}:${line}:${column}`;
      item.tooltip = code ? `${code}: ${message}` : message;
      item.command = {
        command: "vscode.open",
        title: this.t("Open problem"),
        arguments: [vscode.Uri.file(file), { selection: position(row.problem) }],
      };
    }
    return item;
  }

  async openReport(): Promise<void> {
    const lines = [this.running ? this.t("Updating @mf-types") : "@mf-types"];
    if (this.error) lines.push(this.t("Could not update @mf-types: {0}", this.error));
    for (const app of this.sortedApps()) {
      lines.push("", `${appLabel(app)} — ${statusLabel(app.status, this.t)}`);
      if (app.reason) lines.push(app.reason);
      for (const problem of app.problems ?? []) {
        lines.push(
          `${problem.file}:${problem.line}:${problem.column} ${problem.code ?? ""} ${problem.message}`.trim(),
        );
      }
      for (const alias of app.installed ?? [])
        lines.push(this.t("Installed @mf-types for {0}", alias));
    }
    if (!this.apps.size && !this.error) lines.push(this.t("No @mf-types build results yet."));
    const document = await vscode.workspace.openTextDocument({
      language: "plaintext",
      content: lines.join("\n"),
    });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  private sortedApps(): RebuildAppStatus[] {
    return [...this.apps.values()].sort((a, b) => appLabel(a).localeCompare(appLabel(b)));
  }

  private resultFor(row: AppRow): RebuildAppStatus | undefined {
    const result = this.apps.get(row.settingsKey ?? row.app);
    return result && this.matchesResult(row.app, result) ? result : undefined;
  }

  private matchesResult(name: string, result: RebuildAppStatus): boolean {
    // An unreadable config is reported under its settings key, without a resolved federation name.
    return result.app === name || (result.status === "skipped" && result.settingsKey === undefined);
  }

  private publishProblems(): void {
    const byFile = new Map<string, vscode.Diagnostic[]>();
    const seen = new Set<string>();
    for (const app of this.apps.values()) {
      for (const problem of app.problems ?? []) {
        const identity = JSON.stringify(problem);
        if (seen.has(identity)) continue;
        seen.add(identity);
        const diagnostic = new vscode.Diagnostic(
          position(problem),
          problem.message,
          vscode.DiagnosticSeverity.Error,
        );
        diagnostic.source = "MF Dashboard (@mf-types)";
        diagnostic.code = problem.code;
        const entries = byFile.get(problem.file) ?? [];
        entries.push(diagnostic);
        byFile.set(problem.file, entries);
      }
    }
    this.diagnostics.clear();
    this.diagnostics.set([...byFile].map(([file, entries]) => [vscode.Uri.file(file), entries]));
  }

  dispose(): void {
    this.diagnostics.dispose();
    this.change.dispose();
  }
}
