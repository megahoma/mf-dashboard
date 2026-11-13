import path from "node:path";
import { parse as parseEnv } from "dotenv";
import { modeEnvFiles } from "../../../shared/lib/env-files.ts";
import { readConfigInput } from "./config-input.ts";

export function readEnvFile(text: string): Record<string, string> {
  return parseEnv(text);
}

export function readModeEnv(
  dir: string,
  mode: string,
  dependencies?: Set<string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (!/^[\w-]+(?:\.[\w-]+)*$/.test(mode)) return env;
  for (const name of modeEnvFiles(mode)) {
    const file = path.join(dir, name);
    dependencies?.add(file);
    const text = readConfigInput(file, 64 * 1024);
    if (text !== null) Object.assign(env, readEnvFile(text));
  }
  return env;
}
