import fs from "node:fs";
import path from "node:path";
import { noLog } from "../../../shared/config/logging.ts";
import { DEFAULT_ENV_MODE, DEFAULT_START_SCRIPT } from "../../../shared/config/project.ts";
import { logDuration } from "../../../shared/lib/logging.ts";
import type { LogContext } from "../../../shared/models/logging.ts";
import { ALWAYS_SKIP, CONFIG_FILE } from "../config/discover.ts";
import type { LocalApp } from "../models/config.ts";
import type { ScanOptions } from "../models/discover.ts";
import { discoverDirectory } from "./discover-directory.ts";

export function readAppFolder(
  folder: string,
  envMode: string,
  name?: string,
  dependencies?: Set<string>,
  log: LogContext = noLog,
  startScript = DEFAULT_START_SCRIPT,
  configFile?: string,
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
  const apps = discoverDirectory(path.resolve(folder), files, envMode, dependencies, log, {
    startScript,
    configFile,
  });
  if (name === undefined || apps.length === 1) return apps[0] ?? null;
  return apps.find((app) => app.name === name) ?? null;
}

export function scanWorkspace(root: string, options: ScanOptions = {}): Record<string, LocalApp> {
  const started = Date.now();
  const log = options.log ?? noLog;
  const stats = { directories: 0, configs: 0 };
  const found = new Map<string, LocalApp>();
  const rootAbs = path.resolve(root);
  log.event("info", "discovery.scan.started", { root: rootAbs });
  walk(rootAbs, rootAbs, options, found, new Set(), stats);
  logDuration(
    log,
    "discovery.scan.completed",
    started,
    { root: rootAbs, ...stats, apps: found.size },
    "info",
  );
  return Object.fromEntries(found);
}

function walk(
  dir: string,
  root: string,
  options: ScanOptions,
  found: Map<string, LocalApp>,
  claimedConfigs: Set<string>,
  stats: { directories: number; configs: number },
): void {
  const {
    ignorePaths = [],
    envMode = DEFAULT_ENV_MODE,
    startScript,
    log = noLog,
    dependencies,
  } = options;
  let entries: fs.Dirent[];
  stats.directories++;
  dependencies?.add(dir);
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
      if (shouldSkip(entry.name, rel, ignorePaths)) {
        log.event("trace", "discovery.skipped", { path: rel, reason: "excluded-directory" });
        continue;
      }
      children.push(abs);
      continue;
    }
    if (entry.isFile() && CONFIG_FILE.test(entry.name)) configs.push(abs);
  }
  const appDependencies = new Set<string>();
  stats.configs += configs.length;
  const apps =
    configs.length || entries.some((entry) => entry.name === "package.json" && entry.isFile())
      ? discoverDirectory(dir, configs, envMode, appDependencies, log, {
          startScript,
          claimedConfigs,
          ignoreConfig: (file) => {
            const segments = path.relative(root, path.dirname(file)).split(path.sep);
            return segments.some(
              (segment, index) =>
                segment !== "" &&
                shouldSkip(segment, segments.slice(0, index + 1).join("/"), ignorePaths),
            );
          },
        })
      : [];
  const configDependencies = [...appDependencies];
  if (dependencies) for (const file of configDependencies) dependencies.add(file);
  for (const app of apps) {
    const previous = found.get(app.name);
    if (previous && previous.folder !== app.folder) {
      log.event("error", "discovery.duplicate", {
        reason: "duplicate-federation-name",
        app: app.name,
        folder: app.folder,
        previousFolder: previous.folder,
      });
      throw new Error(`duplicate federation name: ${app.name} (${previous.folder}, ${app.folder})`);
    }
    app.configDependencies = configDependencies;
    found.set(app.name, app);
  }
  for (const child of children) walk(child, root, options, found, claimedConfigs, stats);
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
