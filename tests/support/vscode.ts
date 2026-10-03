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
      inspect() {
        return undefined;
      },
      get<T>(_key: string): T | undefined {
        return undefined;
      },
    };
  },
  registerTextDocumentContentProvider: () => ({ dispose() {} }),
  async openTextDocument(uri: Uri) {
    return { uri };
  },
};
export const window = {
  showErrorMessage(_message: string) {},
  async showTextDocument(_document: unknown, _options: unknown) {},
};
export const commands = {
  async executeCommand(_command: string, _uri: Uri) {},
};
