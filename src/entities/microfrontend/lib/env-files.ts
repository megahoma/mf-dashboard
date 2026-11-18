import fs from "node:fs";
import path from "node:path";
import { parse as parseEnv } from "dotenv";
import { DEFAULT_ENV_MODE } from "../../../shared/config/project.ts";
import { modeEnvFiles } from "../../../shared/lib/env-files.ts";
import type { ConfigDirectory, ConfigInput } from "../models/config.ts";
import { readConfigDirectory, readConfigInput } from "./config-input.ts";

const MAX_ENV_OUTPUT_LENGTH = 1024 * 1024;
const MAX_ENV_EXPANSION_WORK = 8 * MAX_ENV_OUTPUT_LENGTH;
const ENV_FILE_LIMIT = 64 * 1024;
const LOCAL_ENV_FILES = [".env", ".env.local"];

export class RslibEnvLimitError extends Error {
  constructor() {
    super("Rslib dotenv expansion exceeded its size or work limit");
  }
}

export function readEnvFile(text: string): Record<string, string> {
  return parseEnv(text);
}

export function readModeEnv(
  dir: string,
  mode: string,
  dependencies?: Set<string>,
  inputs?: Map<string, ConfigInput>,
): Record<string, string> {
  return readEnvFiles(dir, envFilesForMode(mode), dependencies, inputs);
}

export function trackDtsEnvInputs(
  dir: string,
  mode: string,
  inputs: Map<string, ConfigInput>,
  dependencies?: Set<string>,
): void {
  try {
    const canonicalDir = fs.realpathSync(dir);
    for (const name of [...LOCAL_ENV_FILES, ...envFilesForMode(mode)]) {
      const file = path.join(dir, name);
      dependencies?.add(file);
      inputs.set(file, { file, canonical: path.join(canonicalDir, name), limit: ENV_FILE_LIMIT });
    }
  } catch {
    // The package directory disappeared before its dotenv inputs could be recorded.
  }
}

export function readRslibEnv(
  dir: string,
  mode: string,
  dependencies?: Set<string>,
  launchEnv: Readonly<Record<string, string>> = {},
  inputs?: Map<string, ConfigInput>,
  directory = readConfigDirectory(dir),
): Record<string, string> {
  const parsed = directory
    ? readEnvFiles(
        dir,
        [...LOCAL_ENV_FILES, ...envFilesForMode(mode)],
        dependencies,
        inputs,
        directory,
      )
    : {};
  const presets = new Map(
    Object.entries({
      ...launchEnv,
      NODE_ENV: parsed.NODE_ENV || launchEnv.NODE_ENV || DEFAULT_ENV_MODE,
    }),
  );
  const env = new Map(presets);
  const budget = { remainingWork: MAX_ENV_EXPANSION_WORK };
  let remainingLength = MAX_ENV_OUTPUT_LENGTH;
  // Rsbuild merges the env files before expanding their values in declaration order.
  for (const [key, value] of Object.entries(parsed)) {
    const preset = presets.get(key);
    const expanded =
      preset && preset !== value
        ? preset
        : expandEnvValue(value, env, presets, remainingLength, budget);
    if (expanded.length > remainingLength) throw new RslibEnvLimitError();
    chargeExpansionWork(budget, expanded.length);
    parsed[key] = expanded.replace(/\\\$/g, "$");
    remainingLength -= parsed[key].length;
    if (!presets.has(key)) env.set(key, parsed[key]);
  }
  return parsed;
}

function expandEnvValue(
  value: string,
  env: ReadonlyMap<string, string>,
  presets: ReadonlyMap<string, string>,
  remainingLength: number,
  budget: { remainingWork: number },
): string {
  const reference = /(?<!\\)\$\{([^{}]+)\}|(?<!\\)\$([A-Za-z_][A-Za-z0-9_]*)/;
  const seen = new Set<string>();
  for (let steps = 0; ; steps++) {
    chargeExpansionWork(budget, value.length);
    const match = reference.exec(value);
    if (!match || seen.has(value)) break;
    if (steps === 1024) throw new RslibEnvLimitError();
    if (seen.size < 32 && value.length <= 4096) seen.add(value);
    const expression = match[1] ?? match[2];
    const operator = /:?[-+]/.exec(expression);
    const name = operator ? expression.slice(0, operator.index) : expression;
    const argument = operator ? expression.slice(operator.index + operator[0].length) : "";
    const current = env.get(name);
    const replacement = operator?.[0].endsWith("+")
      ? current
        ? argument
        : ""
      : current && current !== value && !seen.has(current)
        ? current
        : argument;
    if (value.length - match[0].length + replacement.length > remainingLength)
      throw new RslibEnvLimitError();
    const expanded =
      value.slice(0, match.index) + replacement + value.slice(match.index + match[0].length);
    if (expanded === value) break;
    value = expanded;
    if (value === current && !presets.has(name)) break;
  }
  return value;
}

function chargeExpansionWork(budget: { remainingWork: number }, length: number): void {
  budget.remainingWork -= length + 1;
  if (budget.remainingWork < 0) throw new RslibEnvLimitError();
}

function envFilesForMode(mode: string): readonly string[] {
  return /^[\w-]+(?:\.[\w-]+)*$/.test(mode) ? modeEnvFiles(mode) : [];
}

function readEnvFiles(
  dir: string,
  files: readonly string[],
  dependencies?: Set<string>,
  inputs?: Map<string, ConfigInput>,
  directory?: ConfigDirectory,
) {
  const env: Record<string, string> = {};
  for (const name of files) {
    const file = path.join(dir, name);
    dependencies?.add(file);
    const text = readConfigInput(file, ENV_FILE_LIMIT, { inputs, expectedDirectory: directory });
    if (text !== null) Object.assign(env, readEnvFile(text));
  }
  return env;
}
