import { diagnosticFields } from "./diagnostic-error.ts";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";
export type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;

export interface LogSink {
  enabled(level: LogLevel): boolean;
  write(level: LogLevel, message: string): void;
}

export interface LogContext {
  event(level: LogLevel, event: string, fields?: LogFields | (() => LogFields)): void;
  operation(source: string): LogContext;
}

export const noLog: LogContext = {
  event() {},
  operation() {
    return noLog;
  },
};

export function safeUrl(value: string): string {
  try {
    if (value.includes("${")) return "[invalid-url]";
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "[invalid-url]";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "[invalid-url]";
  }
}

function singleLine(value: string): string {
  return Array.from(value.slice(0, 512), (char) =>
    char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
      ? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
      : char,
  ).join("");
}

// Messages and causes can contain commands, response bodies and credentials.
// Keep only error identifiers, safe source frames and explicit diagnostic fields.
export function safeError(error: unknown): LogFields {
  try {
    if (!(error instanceof Error)) return { error: "unknown" };
    const code =
      "code" in error && typeof error.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code)
        ? error.code
        : undefined;
    const name =
      /^(Error|TypeError|RangeError|SyntaxError|TimeoutError|AbortError|AggregateError|URIError|EvalError|ReferenceError)$/.test(
        error.name,
      )
        ? error.name
        : "Error";
    const stack = (error.stack ?? "")
      .split("\n")
      .slice(1)
      .filter((frame) => /^\s+at [\w.$<> /():\\-]+:\d+:\d+\)?$/.test(frame))
      .slice(0, 4)
      .map((frame) => frame.trim())
      .join("; ");
    return { error: name, code, stack: stack || undefined, ...diagnosticFields(error) };
  } catch {
    return { error: "unknown" };
  }
}

export function createLogger(sink: LogSink): LogContext {
  let next = 0;
  const context = (operation?: number, source?: string): LogContext => ({
    operation(nextSource) {
      return context(++next, nextSource);
    },
    event(level, event, fields = {}) {
      try {
        if (!sink.enabled(level)) return;
        const values = typeof fields === "function" ? fields() : fields;
        const parts = Object.entries({ operation, source, ...values })
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => {
            const text = String(value);
            const safe =
              typeof value === "string" && /url/i.test(key)
                ? safeUrl(text)
                : text.replace(/https?:\/\/[^\s]+/g, (url) => safeUrl(url));
            return `${singleLine(key)}=${singleLine(safe)}`;
          });
        sink.write(level, `${singleLine(event)} ${parts.join(" ")}`.trim().slice(0, 4096));
      } catch {
        /* Diagnostics must never change the operation's outcome. */
      }
    },
  });
  return context();
}
