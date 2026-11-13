import { isRecord } from "../../../shared/lib/record.ts";
import { TAG, UNKNOWN } from "../config/config.ts";
import type { ObjectValue, Value } from "../models/config.ts";

export function object(value: Value): value is ObjectValue {
  return isRecord(value) && !Object.hasOwn(value, TAG);
}

export function string(value: Value): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export function primitive(value: Value): value is string | number | boolean | null | undefined {
  return (
    value !== UNKNOWN &&
    (value === null || ["string", "number", "boolean", "undefined"].includes(typeof value))
  );
}

export function flag(value: Value, fallback: boolean): boolean {
  if (value === UNKNOWN) return false;
  return typeof value === "boolean" ? value : value && typeof value === "object" ? true : fallback;
}

export function remoteNameSeparator(value: string): number {
  return /^\s*https?:/i.test(value) ? -1 : value.indexOf("@");
}
