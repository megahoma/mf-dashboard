import fs from "node:fs";
import path from "node:path";
import { noLog } from "../../../shared/config/logging.ts";
import { DEFAULT_ENV_MODE, DEFAULT_START_SCRIPT } from "../../../shared/config/project.ts";
import { safeError } from "../../../shared/lib/logging.ts";
import type { LogContext } from "../../../shared/models/logging.ts";
import { CONFIG_EXTENSION } from "../config/discover.ts";
import type { LocalApp } from "../models/config.ts";
import { ConfigImports } from "./config-imports.ts";
import { readConfigInput } from "./config-input.ts";
import { readConfigCandidate } from "./config.ts";
import { joinManifestPath } from "./dev-manifest.ts";
import { readModeEnv } from "./env-files.ts";
import { readLaunchScript } from "./launch-script.ts";
import { parseProgram } from "./syntax.ts";

function isFederationConfig(file: string): boolean {
  return path.basename(file).startsWith("module-federation.config.");
}

export function discoverDirectory(
  dir: string,
  files: string[],
  envMode: string,
  dependencies?: Set<string>,
  log: LogContext = noLog,
  options: {
    startScript?: string;
    configFile?: string;
    claimedConfigs?: Set<string>;
    ignoreConfig?: (file: string) => boolean;
  } = {},
): LocalApp[] {
  const launch = readLaunchScript(dir, options.startScript ?? DEFAULT_START_SCRIPT, dependencies);
  const claimed = options.claimedConfigs;
  if (!launch && claimed) files = files.filter((file) => !claimed.has(file));
  const configuredFile = options.configFile ?? launch?.configFile;
  const selected =
    configuredFile === undefined ? undefined : resolveConfigFile(dir, configuredFile, dependencies);
  if (selected === null) return [];
  if (selected !== undefined) {
    if (options.ignoreConfig?.(selected)) return [];
    claimed?.add(selected);
    files = [selected, ...files.filter((file) => file !== selected && isFederationConfig(file))];
  }
  if (files.length === 0) return [];
  const mode =
    launch?.mode ?? (launch?.program === "vite" && launch.command ? "production" : envMode);
  const defaultNodeEnv = launch?.command ? "production" : DEFAULT_ENV_MODE;
  // Vite sets NODE_ENV before reading the config and loads mode files later.
  const viteProcessEnv =
    launch?.program === "vite"
      ? {
          ...launch.env,
          NODE_ENV: launch.env.NODE_ENV || defaultNodeEnv,
        }
      : undefined;
  let defaultEnv: Record<string, string> | undefined;
  let launchEnv: Record<string, string> | undefined;
  let selectedUsesLaunch: boolean | undefined;
  const apps: LocalApp[] = [];
  const bundlerOutputs: (string | null)[] = [];
  let standaloneZipName: string | undefined;
  let standaloneAppName: string | undefined;
  let standaloneRsbuildManifestFile: string | undefined;
  let rsbuildBase: string | undefined;
  let resolveRsbuildDevManifest: ((file: string) => string | undefined) | undefined;
  const rsbuildApps = new Set<string>();
  let loosePort: number | null = null;
  for (const file of files) {
    log.event("trace", "discovery.candidate", { file });
    dependencies?.add(file);
    let text: string;
    try {
      const source =
        file === selected ? readConfigInput(file, 1024 * 1024) : fs.readFileSync(file, "utf8");
      if (source === null) {
        log.event("trace", "discovery.skipped", { file, reason: "unreadable-config" });
        return [];
      }
      text = source;
    } catch (error) {
      log.event("trace", "discovery.skipped", {
        file,
        reason: "unreadable-config",
        ...safeError(error),
      });
      continue;
    }
    const parsed = parseProgram(text, file, log);
    if (!parsed) {
      if (file === selected) return [];
      continue;
    }
    const imports = new ConfigImports(parsed, dependencies, log);
    const federationConfig = isFederationConfig(file);
    const explicit = file === selected && options.configFile !== undefined;
    const declaredBundler = /^(rsbuild|vite|rspack|webpack)\./.exec(path.basename(file))?.[1];
    const bundler =
      file === selected
        ? explicit
          ? (declaredBundler ?? launch?.program)
          : (launch?.program ?? declaredBundler)
        : undefined;
    const usesLaunch =
      !explicit &&
      launch !== null &&
      (federationConfig
        ? (selectedUsesLaunch ?? true)
        : bundler === launch.program ||
          path.basename(file).startsWith(`${launch.program}.config.`));
    const readCandidate = (useLaunch: boolean, bundlerHint: string | undefined) => {
      const env =
        useLaunch && launch
          ? (launchEnv ??= {
              ...(launch.noEnv ? {} : readModeEnv(dir, mode, dependencies)),
              ...launch.env,
            })
          : (defaultEnv ??= readModeEnv(dir, envMode, dependencies));
      const processEnv = !useLaunch
        ? undefined
        : launch?.program === "rsbuild"
          ? { NODE_ENV: defaultNodeEnv, ...env }
          : viteProcessEnv;
      const candidate = readConfigCandidate(imports, text, env, log, {
        mode: useLaunch ? mode : envMode,
        command: useLaunch ? launch?.command : undefined,
        appDir: dir,
        bundler: bundlerHint,
        preferImportedBundler: explicit,
        processEnv,
      });
      // The implicit Rsbuild launch default is only for discovery. Generation uses its build context.
      if (useLaunch && candidate.app)
        candidate.app.launchEnvironment = { envMode: mode, env: viteProcessEnv ?? env };
      return candidate;
    };
    let candidate = readCandidate(usesLaunch, bundler);
    if (explicit && launch) {
      const withLaunch = readCandidate(true, launch.program);
      // Launch variables can select a different exported factory from the default environment.
      selectedUsesLaunch = (withLaunch.importedBundler ?? candidate.bundler) === launch.program;
      if (selectedUsesLaunch) candidate = withLaunch;
    }
    const {
      app,
      port,
      outputDir,
      bundlerZipName,
      rsbuildBase: base,
      resolveRsbuildDevManifest: resolveDevManifest,
      rsbuildManifestFile,
    } = candidate;
    if (!federationConfig) bundlerOutputs.push(outputDir);
    if (base !== undefined) {
      rsbuildBase = base;
      resolveRsbuildDevManifest = resolveDevManifest;
    }
    if (port !== null) loosePort = port;
    if (!app) {
      log.event("trace", "discovery.skipped", {
        file,
        reason: "no-resolved-federation-name-or-options",
      });
      continue;
    }
    log.event("trace", "discovery.found", { app: app.name, file });
    if (file === selected) return [app];
    const existing = apps.find((item) => item.name === app.name);
    if (!existing) {
      apps.push(app);
      if (federationConfig) {
        standaloneAppName = app.name;
        standaloneZipName = bundlerZipName;
        standaloneRsbuildManifestFile = rsbuildManifestFile;
      }
    } else {
      if (existing.port === null && app.port !== null) existing.port = app.port;
      if (base !== undefined && !rsbuildApps.has(app.name)) {
        existing.manifestPath = app.manifestPath;
        if (app.port === null || existing.port === app.port)
          existing.devManifestPath = app.devManifestPath;
      }
      if (
        app.buildConfigFile &&
        existing.buildConfigFile &&
        isFederationConfig(existing.buildConfigFile) &&
        !federationConfig
      ) {
        existing.buildConfigFile = app.buildConfigFile;
        existing.generatedZipPath = app.generatedZipPath;
      }
    }
    if (base !== undefined) rsbuildApps.add(app.name);
  }
  if (apps.length === 1) {
    const [app] = apps;
    if (app.port === null && app.name === standaloneAppName && bundlerOutputs.length === 1)
      app.port = loosePort;
    if (
      standaloneRsbuildManifestFile !== undefined &&
      rsbuildBase !== undefined &&
      bundlerOutputs.length === 1 &&
      !rsbuildApps.has(app.name)
    ) {
      app.manifestPath = joinManifestPath(rsbuildBase, standaloneRsbuildManifestFile);
      if (loosePort === null || loosePort === app.port) {
        const devManifestPath = resolveRsbuildDevManifest?.(standaloneRsbuildManifestFile);
        if (devManifestPath && devManifestPath !== app.manifestPath)
          app.devManifestPath = devManifestPath;
      }
    }
    if (
      standaloneZipName &&
      app.buildConfigFile &&
      isFederationConfig(app.buildConfigFile) &&
      bundlerOutputs.length
    ) {
      const outputDir = bundlerOutputs.length === 1 ? bundlerOutputs[0] : null;
      app.generatedZipPath = outputDir ? path.resolve(dir, outputDir, standaloneZipName) : null;
    }
  }
  return apps;
}

function resolveConfigFile(
  dir: string,
  specifier: string,
  dependencies?: Set<string>,
): string | null {
  const candidate = path.resolve(dir, specifier);
  const relative = path.relative(dir, candidate);
  if (
    !CONFIG_EXTENSION.test(candidate) ||
    path.isAbsolute(relative) ||
    relative
      .split(path.sep)
      .some((part) => part === ".." || part === "node_modules" || part === ".git")
  )
    return null;
  dependencies?.add(candidate);
  try {
    if (!fs.lstatSync(candidate).isFile()) return null;
    const root = fs.realpathSync(dir);
    const real = fs.realpathSync(candidate);
    return real === path.resolve(root, relative) ? candidate : null;
  } catch {
    return null;
  }
}
