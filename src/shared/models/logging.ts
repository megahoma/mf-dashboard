export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;

export type LogSink = {
  enabled(level: LogLevel): boolean;
  write(level: LogLevel, message: string): void;
};

export type LogContext = {
  event(level: LogLevel, event: string, fields?: LogFields | (() => LogFields)): void;
  operation(source: string): LogContext;
};
