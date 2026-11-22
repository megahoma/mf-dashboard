import * as vscode from "vscode";
import { appsByName, rootApps, type LocalApp } from "../../entities/microfrontend/index.ts";
import { workspaceTypesPlan, type RebuildAppStatus } from "../../features/rebuild-types/index.ts";
import type { SourceProblem } from "../../shared/models/source-problem.ts";

export type TypesBuildSnapshot = {
  apps: RebuildAppStatus[];
  error?: string;
};

type AppTarget = Pick<RebuildAppStatus, "app" | "settingsKey">;
type AppRow = AppTarget & { id?: string; children?: AppRow[] };
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
      return t("Up to date");
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
  private readonly change = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.change.event;
  private readonly diagnostics = vscode.languages.createDiagnosticCollection(
    "mf-dashboard-types-build",
  );
  private readonly apps = new Map<string, RebuildAppStatus>();
  private loaded: readonly LocalApp[] = [];
  private structure: "flat" | "tree" = "tree";
  private roots: AppRow[] = [];
  private workspaceApps = new Map<string, LocalApp>();
  private dependencies = new Map<string, string[]>();
  private running = false;
  private error: string | undefined;
  private t: Translate;

  constructor(previous?: TypesBuildSnapshot, t: Translate = vscode.l10n.t) {
    this.t = t;
    for (const app of previous?.apps ?? []) this.apps.set(app.settingsKey ?? app.app, app);
    this.error = previous?.error;
  }

  relabel(t: Translate): void {
    this.t = t;
    this.change.fire();
  }

  setWorkspace(loaded: readonly LocalApp[], structure: "flat" | "tree"): void {
    if (loaded === this.loaded && structure === this.structure) return;
    if (loaded !== this.loaded) {
      this.loaded = loaded;
      this.workspaceApps = new Map(loaded.map((app) => [app.settingsKey ?? app.name, app]));
      this.dependencies = new Map(
        workspaceTypesPlan(loaded).order.map(({ app, dependencies }) => [app.name, dependencies]),
      );
    }
    this.structure = structure;
    const byName = appsByName(loaded.filter((app) => this.dependencies.has(app.name)));
    const dependenciesOf = (app: LocalApp) => this.dependencies.get(app.name) ?? [];
    const expanded = new Set<string>();
    const build = (app: LocalApp, parent?: string): AppRow => {
      const key = app.settingsKey ?? app.name;
      const children: AppRow[] = [];
      if (structure === "tree" && !expanded.has(key)) {
        expanded.add(key);
        for (const name of dependenciesOf(app)) {
          const child = byName.get(name);
          if (child) children.push(build(child, key));
        }
      }
      return {
        app: app.name,
        settingsKey: app.settingsKey,
        children,
        id: parent === undefined ? `types:${key}` : `types-link:${JSON.stringify([parent, key])}`,
      };
    };
    this.roots = rootApps(loaded, byName, structure, dependenciesOf).map((app) => build(app));
    this.change.fire();
  }

  targetFor(row?: Row): AppTarget | undefined {
    if (!row || !("app" in row)) return;
    const app = this.workspaceApps.get(row.settingsKey ?? row.app);
    if (app?.name === row.app && this.dependencies.has(app.name))
      return { app: app.name, settingsKey: app.settingsKey };
  }

  start(target?: AppTarget): void {
    this.running = true;
    this.error = undefined;
    if (target) {
      this.update([{ ...target, status: "queued" }]);
      return;
    }
    this.apps.clear();
    this.diagnostics.clear();
    this.change.fire();
  }

  update(updates: readonly RebuildAppStatus[]): void {
    let changed = false;
    for (const update of updates) {
      const key = update.settingsKey ?? update.app;
      if (update.problems?.length || this.apps.get(key)?.problems?.length) changed = true;
      this.apps.set(key, update);
    }
    if (changed) this.publishProblems();
    this.change.fire();
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
      const item = new vscode.TreeItem(
        appLabel(row),
        row.children?.length
          ? vscode.TreeItemCollapsibleState.Expanded
          : this.getChildren(row).length
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None,
      );
      const result = this.resultFor(row);
      item.id = row.id ?? `types:${row.settingsKey ?? row.app}`;
      item.description = result ? statusLabel(result.status, this.t) : this.t("Not built yet");
      item.iconPath = new vscode.ThemeIcon(result ? icons[result.status] : "package");
      item.tooltip = result?.reason;
      if (this.targetFor(row)) item.contextValue = "typesBuildApp";
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
