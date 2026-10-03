import fs from "node:fs";
import path from "node:path";
import { discoverProgram, readPort, type LocalApp } from "./config.ts";
import { parseProgram } from "./syntax.ts";
export { discoverSource } from "./config.ts";
export type { LocalApp } from "./config.ts";

export interface ScanOptions {
  ignorePaths?: readonly string[];
  envMode?: string;
}

const CONFIG_FILE =
  /^(module-federation|webpack|rspack|rsbuild|vite)\.config\.(?:mjs|cjs|js|mts|cts|ts|jsx|tsx)$/;
const ALWAYS_SKIP = new Set(["node_modules", ".git", "dist"]);

export function readAppFolder(
  folder: string,
  envMode: string,
  name?: string,
  dependencies?: Set<string>,
): LocalApp | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return null;
  }
  const files = entries
    .filter((entry) => entry.isFile() && CONFIG_FILE.test(entry.name))
    .map((entry) => path.join(folder, entry.name))
    .sort();
  const apps = discoverDirectory(path.resolve(folder), files, envMode, dependencies);
  return apps.find((app) => app.name === name) ?? apps[0] ?? null;
}
export function readEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function scanWorkspace(root: string, options: ScanOptions = {}): Record<string, LocalApp> {
  const found: Record<string, LocalApp> = {};
  const rootAbs = path.resolve(root);
  walk(rootAbs, rootAbs, options.ignorePaths ?? [], options.envMode ?? "development", found);
  return found;
}

function walk(
  dir: string,
  root: string,
  ignorePaths: readonly string[],
  envMode: string,
  found: Record<string, LocalApp>,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const configs: string[] = [];
  const children: string[] = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (shouldSkip(entry.name, rel, ignorePaths)) continue;
      children.push(abs);
      continue;
    }
    if (entry.isFile() && CONFIG_FILE.test(entry.name)) configs.push(abs);
  }
  for (const app of discoverDirectory(dir, configs, envMode)) {
    if (!(app.name in found)) found[app.name] = app;
  }
  for (const child of children) walk(child, root, ignorePaths, envMode, found);
}

function shouldSkip(name: string, relPosix: string, extra: readonly string[]): boolean {
  if (ALWAYS_SKIP.has(name)) return true;
  for (const raw of extra) {
    const item = raw.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (item === "") continue;
    if (!item.includes("/")) {
      if (name === item) return true;
      continue;
    }
    if (relPosix === item || relPosix.startsWith(`${item}/`)) return true;
  }
  return false;
}

function discoverDirectory(
  dir: string,
  files: string[],
  envMode: string,
  dependencies?: Set<string>,
): LocalApp[] {
  if (files.length === 0) return [];
  const env = readModeEnv(dir, envMode);
  const apps: LocalApp[] = [];
  let loosePort: number | null = null;
  for (const file of files) {
    dependencies?.add(file);
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const parsed = parseProgram(text);
    const port =
      readPort(parsed.server, parsed.bindings, env) ??
      readPort(parsed.devServer, parsed.bindings, env);
    if (port !== null) loosePort = port;
    const app = discoverProgram(parsed, text, file, env, dependencies);
    if (!app) continue;
    const existing = apps.find((item) => item.name === app.name);
    if (!existing) apps.push(app);
    else if (existing.port === null && app.port !== null) existing.port = app.port;
  }
  if (apps.length === 1 && apps[0].port === null && loosePort !== null) apps[0].port = loosePort;
  return apps;
}

function readModeEnv(dir: string, mode: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!/^[A-Za-z0-9_-]+$/.test(mode)) return env;
  for (const name of [`.env.${mode}`, `.env.${mode}.local`]) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    Object.assign(env, readEnvFile(fs.readFileSync(file, "utf8")));
  }
  return env;
}
