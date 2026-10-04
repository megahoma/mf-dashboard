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

export const languages = {
  createDiagnosticCollection: () => ({ set(_entries: unknown) {}, dispose() {} }),
};
export const workspace = {
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
  registerTextDocumentContentProvider: () => ({ dispose() {} }),
  async openTextDocument(uri: Uri) {
    return { uri };
  },
};
export const LogLevel = { Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5, Off: 6 };
export const ConfigurationTarget = { Workspace: 2 };
export const l10n = { t: (text: string) => text };
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
  registerTreeDataProvider: () => ({ dispose() {} }),
  showErrorMessage(_message: string) {},
  async showTextDocument(_document: unknown, _options: unknown) {},
};
export const commands = {
  registerCommand(name: string, handler: (...args: unknown[]) => unknown) {
    registeredCommands.set(name, handler);
    return { dispose: () => registeredCommands.delete(name) };
  },
  async executeCommand(_command: string, _uri: Uri) {},
};

export class Range {
  constructor(_a: number, _b: number, _c: number, _d: number) {}
}
export class Diagnostic {
  source?: string;
  constructor(_range: Range, _message: string, _severity: number) {}
}
export const DiagnosticSeverity = { Warning: 1, Information: 2 };
