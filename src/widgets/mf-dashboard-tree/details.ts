import type { Disposable, TreeView, WebviewView, WebviewViewProvider } from "vscode";
import type { MfDashboardProvider } from "./provider.ts";
import type { DashboardNode } from "./presentation.ts";

export class DashboardDetails implements WebviewViewProvider {
  private readonly provider: MfDashboardProvider;
  private readonly selectionSubscription: Disposable;
  private selectedId: string | undefined;
  private activeView: { render(): void; dispose(): void } | undefined;

  constructor(tree: TreeView<DashboardNode>, provider: MfDashboardProvider) {
    this.provider = provider;
    this.selectedId = tree.selection[0]?.id;
    // Refreshing a collapsed tree can empty tree.selection without a selection event.
    this.selectionSubscription = tree.onDidChangeSelection(({ selection }) => {
      this.selectedId = selection[0]?.id;
      this.activeView?.render();
    });
  }

  resolveWebviewView(view: WebviewView): void {
    this.activeView?.dispose();
    view.webview.options = { localResourceRoots: [] };
    let previousHtml: string | undefined;
    const render = () => {
      if (!view.visible) return;
      const row =
        this.selectedId === undefined ? undefined : this.provider.findRow(this.selectedId);
      const html = detailsHtml(row, this.provider.session.terms.selectForDetails);
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

  dispose(): void {
    this.selectionSubscription.dispose();
    this.activeView?.dispose();
  }
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function detailsHtml(row: DashboardNode | undefined, empty: string): string {
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
      padding: 8px 12px;
      font: var(--vscode-font-size) / 1.5 var(--vscode-font-family);
      color: var(--vscode-sideBar-foreground, var(--vscode-foreground));
      background: var(--vscode-sideBar-background);
      overflow-wrap: anywhere;
    }
    h1 { font-size: 1em; margin: 0 0 4px; }
    p { margin: 0; white-space: pre-wrap; }
    .empty { color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <main>${row ? `<h1>${escapeHtml(row.name)}</h1><p>${escapeHtml(row.tooltip)}</p>` : `<p class="empty">${escapeHtml(empty)}</p>`}</main>
</body>
</html>`;
}
