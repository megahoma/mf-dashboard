import type { AstPath } from "./syntax.ts";

export type ExportedValue = AstPath | { object: AstPath; imported: string };

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
