import type { AstPath } from "./syntax.ts";

export type ExportedValue = AstPath | { object: AstPath; imported: string };
export type ResolvedExport = { value: ExportedValue; files: readonly string[] };

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
