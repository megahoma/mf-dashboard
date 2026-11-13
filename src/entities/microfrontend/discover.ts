import { logDuration, noLog, safeError, type LogContext } from "../../shared/logging.ts";
import fs from "node:fs";
import { parse as parseEnv } from "dotenv";
import path from "node:path";
import { joinManifestPath, readConfigCandidate, type LocalApp } from "./config.ts";
import { ConfigImports } from "./config-imports.ts";
import { parseProgram } from "./syntax.ts";
import { readConfigInput } from "./config-input.ts";
export { discoverSource } from "./config.ts";
export type { LocalApp } from "./config.ts";

export interface ScanOptions {
  ignorePaths?: readonly string[];
  envMode?: string;
  startScript?: string;
  log?: LogContext;
  dependencies?: Set<string>;
}

const CONFIG_FILE =
  /^(module-federation|webpack|rspack|rsbuild|vite)\.config\.(?:mjs|cjs|js|mts|cts|ts|jsx|tsx)$/;
const CONFIG_EXTENSION = /\.(?:mjs|cjs|js|mts|cts|ts|jsx|tsx)$/;
const ALWAYS_SKIP = new Set(["node_modules", ".git", "dist"]);
const CAC_GLOBAL_SWITCHES = ["help", "h", "version", "v"];
const VITE_GLOBAL_SWITCHES = [...CAC_GLOBAL_SWITCHES, "clearScreen"];
const RSBUILD_GLOBAL_SWITCHES = [...CAC_GLOBAL_SWITCHES, "env", "sourceMap"];
const CAC_COMMAND_SWITCHES = {
  vite: {
    build: new Set([...VITE_GLOBAL_SWITCHES, "emptyOutDir", "watch", "w", "app"]),
    preview: new Set([...VITE_GLOBAL_SWITCHES, "strictPort"]),
  },
  rsbuild: {
    build: new Set([...RSBUILD_GLOBAL_SWITCHES, "watch", "w"]),
    preview: new Set([...RSBUILD_GLOBAL_SWITCHES, "strictPort"]),
  },
};

function isFederationConfig(file: string): boolean {
  return path.basename(file).startsWith("module-federation.config.");
}

export function readAppFolder(
  folder: string,
  envMode: string,
  name?: string,
  dependencies?: Set<string>,
  log: LogContext = noLog,
  startScript = "dev",
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
export function readEnvFile(text: string): Record<string, string> {
  return parseEnv(text);
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
    envMode = "development",
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

function discoverDirectory(
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
  const launch = readLaunchScript(dir, options.startScript ?? "dev", dependencies);
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
  const defaultNodeEnv = launch?.command ? "production" : "development";
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

export function readModeEnv(
  dir: string,
  mode: string,
  dependencies?: Set<string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (!/^[\w-]+(?:\.[\w-]+)*$/.test(mode)) return env;
  for (const name of [`.env.${mode}`, `.env.${mode}.local`]) {
    const file = path.join(dir, name);
    dependencies?.add(file);
    const text = readConfigInput(file, 64 * 1024);
    if (text !== null) Object.assign(env, readEnvFile(text));
  }
  return env;
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

function readLaunchScript(
  dir: string,
  scriptName: string,
  dependencies?: Set<string>,
): {
  program: string;
  env: Record<string, string>;
  mode?: string;
  command?: string;
  configFile?: string;
  noEnv: boolean;
} | null {
  const file = path.join(dir, "package.json");
  dependencies?.add(file);
  try {
    const text = readConfigInput(file, 512 * 1024);
    if (text === null) return null;
    const pkg = JSON.parse(text) as { scripts?: Record<string, unknown> };
    if (!pkg.scripts || !Object.hasOwn(pkg.scripts, scriptName)) return null;
    const script = pkg.scripts[scriptName];
    if (typeof script !== "string" || !/^[\w.@:/=+\- \t]+$/.test(script)) return null;
    const words = script.trim().split(/\s+/);
    let index = words[0] === "cross-env" ? 1 : 0;
    const env: Record<string, string> = Object.create(null);
    for (; index < words.length; index++) {
      const pair = /^([A-Za-z_][\w]*)=(.*)$/.exec(words[index]);
      if (!pair) break;
      env[pair[1]] = pair[2];
    }
    const program = (words[index] ?? "").replace(/\.cmd$/, "");
    if (!/^(rsbuild|vite|rspack|webpack)$/.test(program)) return null;
    const separator = words.indexOf("--", index + 1);
    const args = words.slice(index + 1, separator === -1 ? undefined : separator);
    const action = program === "vite" || program === "rsbuild" ? cacAction(args, program) : args[0];
    const command = action === "build" || action === "preview" ? action : undefined;
    const modeFlags =
      program === "rsbuild" ? ["--env-mode"] : program === "vite" ? ["--mode", "-m"] : [];
    const requestedMode = launchOption(args, modeFlags);
    const mode =
      requestedMode && /^[\w-]+(?:\.[\w-]+)*$/.test(requestedMode) ? requestedMode : undefined;
    return {
      program,
      env,
      mode,
      command,
      configFile: launchOption(
        args,
        program === "rsbuild" || program === "vite" ? ["--config", "-c"] : ["--config"],
      ),
      noEnv: program === "rsbuild" && args.includes("--no-env"),
    };
  } catch {
    return null;
  }
}

function cacAction(
  args: readonly string[],
  program: keyof typeof CAC_COMMAND_SWITCHES,
): string | undefined {
  const { build, preview } = CAC_COMMAND_SWITCHES[program];
  // CAC keeps the last matching command. Both tools register preview after build.
  if (cacPositional(args, preview) === "preview") return "preview";
  if (cacPositional(args, build) === "build") return "build";
}

function cacPositional(args: readonly string[], switches: ReadonlySet<string>): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("-")) return arg;
    if (arg.startsWith("--no-")) continue;
    const [flag, attached] = arg.split("=", 2);
    const name = flag.startsWith("--") ? flag.slice(2) : flag.slice(-1);
    const next = args[index + 1];
    const value = attached || (next?.startsWith("-") ? undefined : next);
    if (value === undefined) continue;
    if (switches.has(name) && value !== "true" && value !== "false") return value;
    if (!attached) index++;
  }
}

function launchOption(args: string[], flags: string[]): string | undefined {
  let result: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    const flag = flags.find((option) => word === option || word.startsWith(option + "="));
    if (!flag) continue;
    const value = word === flag ? args[++index] : word.slice(flag.length + 1);
    if (value && !value.startsWith("-")) result = value;
  }
  return result;
}
