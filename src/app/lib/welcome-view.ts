import type { Event, WebviewViewProvider } from "vscode";
import { escapeHtml } from "../../shared/lib/html.ts";

export function createWelcomeView(
  onChange: Event<unknown>,
  model: () => { message: string; label: string },
): WebviewViewProvider {
  return {
    resolveWebviewView(view) {
      const { webview } = view;
      webview.options = { localResourceRoots: [], enableCommandUris: ["mf-dashboard.discover"] };
      let previousHtml: string | undefined;
      const render = () => {
        const { message, label } = model();
        const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <title>MF Dashboard</title>
  <style>
    body {
      box-sizing: border-box;
      display: grid;
      place-items: start center;
      min-height: 100vh;
      margin: 0;
      padding: 16px;
      background: var(--vscode-sideBar-background);
      color: var(--vscode-sideBar-foreground, var(--vscode-foreground));
      font: var(--vscode-font-size) / 1.5 var(--vscode-font-family);
    }
    main { width: min(100%, 25rem); text-align: center; overflow-wrap: anywhere; }
    p { margin: 0 0 12px; }
    a {
      box-sizing: border-box;
      display: inline-block;
      max-width: 100%;
      padding: 5px 12px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 2px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      text-decoration: none;
    }
    a:hover { background: var(--vscode-button-hoverBackground); }
    a:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  </style>
</head>
<body>
  <main><p>${escapeHtml(message)}</p><a href="command:mf-dashboard.discover">${escapeHtml(label)}</a></main>
</body>
</html>`;
        if (html !== previousHtml) {
          webview.html = html;
          previousHtml = html;
        }
      };
      const subscription = onChange(render);
      view.onDidDispose(() => subscription.dispose());
      render();
    },
  };
}
