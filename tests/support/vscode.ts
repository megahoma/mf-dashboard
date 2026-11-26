import path from "node:path";
// Only the VS Code APIs exercised by the navigation tests.
export class Uri {
  readonly scheme: string;
  readonly path: string;
  readonly query: string;
  constructor(scheme: string, path: string, query: string = "") {
    this.scheme = scheme;
    this.path = path;
    this.query = query;
  }
  static from(value: { scheme: string; path: string; query?: string }): Uri {
    return new Uri(value.scheme, value.path, value.query);
  }
  static file(path: string): Uri {
    return new Uri("file", path);
  }
  static parse(value: string): Uri {
    const url = new URL(value);
    return new Uri(url.protocol.slice(0, -1), `//${url.host}${url.pathname}`, url.search.slice(1));
  }
  get fsPath(): string {
    return this.path;
  }
  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri(base.scheme, path.join(base.path, ...parts));
  }
  toString(): string {
    return `${this.scheme}:${this.path}?${this.query}`;
  }
}

export class EventEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>();
  readonly event = (listener: (value: T) => void) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value: T): void {
    for (const listener of this.listeners) listener(value);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export class TreeItem {
  readonly label: string;
  readonly collapsibleState: number;
  constructor(label: string, collapsibleState: number) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}
export class ThemeIcon {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
}
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };

export const languages = {
  createDiagnosticCollection: () => ({ set(_entries: unknown) {}, clear() {}, dispose() {} }),
};
export const workspace = {
  isTrusted: true,
  asRelativePath(file: string) {
    return file;
  },
  getConfiguration() {
    return {
      async update(_key: string, _value: unknown, _target: unknown) {},
      inspect() {
        return undefined;
      },
      get<T>(_key: string): T | undefined {
        return undefined;
      },
    };
  },
  onDidSaveTextDocument: () => ({ dispose() {} }),
  onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
  onDidChangeConfiguration: () => ({ dispose() {} }),
  createFileSystemWatcher: (
    _pattern?: string,
    _ignoreCreate?: boolean,
    _ignoreChange?: boolean,
  ) => ({
    onDidCreate: (_callback: (uri: Uri) => void) => ({ dispose() {} }),
    onDidChange: (_callback: (uri: Uri) => void) => ({ dispose() {} }),
    onDidDelete: (_callback: (uri: Uri) => void) => ({ dispose() {} }),
    dispose() {},
  }),
  registerTextDocumentContentProvider: () => ({ dispose() {} }),
  async openTextDocument(uri: Uri) {
    return { uri };
  },
};
export const LogLevel = { Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5, Off: 0 };
export const ConfigurationTarget = { Workspace: 2 };
export const l10n = { t: (text: string) => text };
export const env = {
  clipboard: { async writeText(_text: string) {} },
  async openExternal(_uri: Uri) {
    return true;
  },
};
export const outputChannels: {
  name: string;
  options: { log: boolean };
  shown: number;
  disposed: boolean;
  messages: string[];
  logLevel: number;
}[] = [];
export const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
export const window = {
  async withProgress<T>(
    _options: { location: { viewId: string }; title: string },
    task: (progress: { report(message: { message: string }): void }) => Promise<T>,
  ): Promise<T> {
    return task({ report() {} });
  },
  async showInformationMessage(_message: string) {},
  createOutputChannel(name: string, options: { log: boolean }) {
    const state = {
      name,
      options,
      shown: 0,
      disposed: false,
      messages: [] as string[],
      logLevel: LogLevel.Info,
    };
    outputChannels.push(state);
    const write = (message: string) => state.messages.push(message);
    return Object.assign(state, {
      trace: write,
      debug: write,
      info: write,
      warn: write,
      error: write,
      show: () => {
        state.shown++;
      },
      dispose: () => {
        state.disposed = true;
      },
    });
  },
  createTreeView(_id: string, _options: { treeDataProvider: unknown }) {
    const selection = new EventEmitter<unknown>();
    const visibility = new EventEmitter<{ visible: boolean }>();
    return {
      selection: [],
      message: undefined as string | undefined,
      onDidChangeSelection: selection.event,
      onDidChangeVisibility: visibility.event,
      setVisible: (visible: boolean) => visibility.fire({ visible }),
      dispose: () => {
        visibility.dispose();
        selection.dispose();
      },
    };
  },
  registerWebviewViewProvider: (_id: string, _provider: unknown) => ({ dispose() {} }),
  showErrorMessage(_message: string) {},
  setStatusBarMessage(_message: string, _hideAfter: number) {
    return { dispose() {} };
  },
  async showTextDocument(_document: unknown, _options: unknown) {},
};
export const commands = {
  registerCommand(name: string, handler: (...args: unknown[]) => unknown) {
    registeredCommands.set(name, handler);
    return { dispose: () => registeredCommands.delete(name) };
  },
  async executeCommand(_command: string, ..._args: unknown[]) {},
};

export class Range {
  readonly start: { line: number; character: number };
  readonly end: { line: number; character: number };
  constructor(a: number, b: number, c: number, d: number) {
    this.start = { line: a, character: b };
    this.end = { line: c, character: d };
  }
}
export class Diagnostic {
  source?: string;
  code?: string;
  readonly range: Range;
  readonly message: string;
  readonly severity: number;
  constructor(range: Range, message: string, severity: number) {
    this.range = range;
    this.message = message;
    this.severity = severity;
  }
}
export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2 };
