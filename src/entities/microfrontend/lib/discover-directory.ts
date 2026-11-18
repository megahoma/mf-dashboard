import fs from "node:fs";
import path from "node:path";
import { noLog } from "../../../shared/config/logging.ts";
import {
  DEFAULT_ENV_MODE,
  DEFAULT_START_SCRIPT,
  DEFAULT_TSCONFIG,
} from "../../../shared/config/project.ts";
import { safeError } from "../../../shared/lib/logging.ts";
import { canonicalPathIsInside, pathIsInside } from "../../../shared/lib/paths.ts";
import type { LogContext } from "../../../shared/models/logging.ts";
import { MAX_CONFIG_LOCATION_LENGTH } from "../config/config.ts";
import { CONFIG_EXTENSION, RSLIB_CONFIG_NAMES, VITE_CONFIG_NAMES } from "../config/discover.ts";
import type {
  ConfigCandidate,
  ConfigDirectory,
  ConfigInput,
  FederationOwnership,
  LocalApp,
} from "../models/config.ts";
import type { FederationOwnershipCheck } from "../models/discover.ts";
import { ConfigImports } from "./config-imports.ts";
import {
  canonicalDirectoryPath,
  configDirectoryIdentity,
  CONFIG_INPUT_LIMIT,
  packageManifestInput,
  readConfigDirectory,
  readConfigInput,
} from "./config-input.ts";
import { readConfigCandidate, readRslibDevelopmentHelpers } from "./config.ts";
import { joinManifestPath, joinViteManifestPath } from "./dev-manifest.ts";
import { readModeEnv, readRslibEnv, RslibEnvLimitError, trackDtsEnvInputs } from "./env-files.ts";
import { readLaunchScript } from "./launch-script.ts";
import { isRslibLauncherAncestor } from "./rslib-launcher.ts";
import { parseProgram } from "./syntax.ts";

function isFederationConfig(file: string): boolean {
  return path.basename(file).startsWith("module-federation.config.");
}

function isRslibConfig(file: string): boolean {
  return path.basename(file).startsWith("rslib.config.");
}

export function federationClaimKey(file: string, name: string, origin: string): string {
  return `${file}\0${origin}\0${name}`;
}

type DirectoryCandidate = {
  file: string;
  candidate: ConfigCandidate;
  inputs: ReadonlyMap<string, ConfigInput>;
  usesLaunch: boolean;
  federationKey?: string;
};

export function discoverDirectory(
  dir: string,
  files: string[],
  envMode: string,
  dependencies?: Set<string>,
  log: LogContext = noLog,
  options: {
    startScript?: string;
    configFile?: string;
    workspaceRoot?: string;
    claimedConfigs?: Set<string>;
    ownedFederationConfigs?: Set<string>;
    ownershipSources?: Set<string>;
    resolveOwnershipFor?: { name: string; reads: Set<string> };
    ignoreConfig?: (file: string) => boolean;
    ignoreDirectory?: (folder: string) => boolean;
  } = {},
): ((isWorkspaceOwnedConfig?: FederationOwnershipCheck) => LocalApp[]) | undefined {
  const launchFolder = dir;
  const launchInputs = new Map<string, ConfigInput>();
  const launch = readLaunchScript(
    launchFolder,
    options.startScript ?? DEFAULT_START_SCRIPT,
    dependencies,
    launchInputs,
  );
  const claimed = options.claimedConfigs;
  if (!launch && claimed) files = files.filter((file) => !claimed.has(file));
  const workspaceRoot = options.workspaceRoot ?? dir;
  const scopes = new Map<string, PackageScope | null>();
  const scopeOf = (folder: string) => {
    if (!scopes.has(folder)) scopes.set(folder, packageScope(folder, workspaceRoot, dependencies));
    return scopes.get(folder) ?? null;
  };
  const isLaunchPackage = (selected: PackageScope) => {
    const launcher = scopeOf(launchFolder);
    return (
      launcher !== null &&
      (launcher.packageDir === selected.packageDir ||
        canonicalPathIsInside(launcher.directory.path, selected.packageDir))
    );
  };
  const scriptRoot = resolveDirectory(dir, launch?.root, workspaceRoot, dependencies, launchInputs);
  const keepIndependentConfigs = launch?.root !== undefined && options.configFile === undefined;
  const launchRoot = scriptRoot ?? dir;
  const usesProjectRoot = launchRoot !== launchFolder;
  let rootDefault: string | undefined;
  if (usesProjectRoot) {
    const rootConfigs = RSLIB_CONFIG_NAMES.map((name) => path.join(launchRoot, name));
    const entries = rootConfigs.filter((file) => {
      dependencies?.add(file);
      return (
        fs.existsSync(file) &&
        !options.ignoreConfig?.(file) &&
        resolveConfigFile(launchRoot, file) !== null
      );
    });
    files = [...files, ...entries];
    rootDefault = rootConfigs.find((file) => fs.existsSync(file));
  }
  let inactiveRslibFiles: string[] = [];
  const scriptFile = launch?.configFile ?? rootDefault;
  const scriptConfigRoot = usesProjectRoot ? workspaceRoot : launchRoot;
  const launchConfig =
    scriptRoot !== null && scriptFile !== undefined
      ? resolveConfigFile(scriptConfigRoot, path.resolve(launchRoot, scriptFile), dependencies)
      : undefined;
  const selectedConfig =
    options.configFile !== undefined
      ? resolveConfigFile(launchFolder, options.configFile, dependencies)
      : usesProjectRoot && scriptFile === undefined
        ? null
        : launchConfig;
  if (selectedConfig === null && !keepIndependentConfigs) return;
  const selected = selectedConfig ?? undefined;
  const scriptConfig =
    launch?.program === "rslib" && options.configFile !== undefined ? launchConfig : undefined;
  const selectedIsIgnored =
    selected !== undefined &&
    (options.ignoreConfig?.(selected) ||
      (options.configFile === undefined &&
        launch?.root !== undefined &&
        options.ignoreDirectory?.(path.resolve(dir, launch.root))));
  if (selected !== undefined) {
    if (selectedIsIgnored && launch?.program !== "rslib") return;
    if (!launch && claimed?.has(selected)) return;
    if (!usesProjectRoot) claimed?.add(selected);
    inactiveRslibFiles.push(...files.filter((file) => file !== selected && isRslibConfig(file)));
    if (scriptConfig && scriptConfig !== selected && !options.ignoreConfig?.(scriptConfig)) {
      if (!inactiveRslibFiles.includes(scriptConfig)) inactiveRslibFiles.push(scriptConfig);
      claimed?.add(scriptConfig);
    }
    files = [
      ...inactiveRslibFiles,
      selected,
      ...files.filter(
        (file) =>
          file !== selected &&
          (isFederationConfig(file) || (keepIndependentConfigs && !isRslibConfig(file))),
      ),
    ];
  } else {
    if (launch?.program === "vite") {
      const viteDefault = VITE_CONFIG_NAMES.map((name) => path.join(dir, name)).find((file) => {
        dependencies?.add(file);
        return files.includes(file);
      });
      if (viteDefault)
        files = files.filter(
          (file) => file === viteDefault || !path.basename(file).startsWith("vite.config."),
        );
    }
    const rslibFiles = files.filter(isRslibConfig);
    if (launch?.program !== "rslib" && files.length) {
      for (const name of [...RSLIB_CONFIG_NAMES, "rslib.config.jsx", "rslib.config.tsx"]) {
        dependencies?.add(path.join(dir, name));
      }
    }
    const rslibDefault =
      launch?.program === "rslib" &&
      RSLIB_CONFIG_NAMES.map((name) => path.join(dir, name)).find((file) => {
        dependencies?.add(file);
        return fs.existsSync(file);
      });
    if (launch?.program === "rslib")
      inactiveRslibFiles =
        keepIndependentConfigs &&
        (usesProjectRoot || scriptRoot === null || scriptFile !== undefined)
          ? rslibFiles
          : rslibFiles.filter((file) => file !== rslibDefault);
    files = [...rslibFiles, ...files.filter((file) => !isRslibConfig(file))];
  }
  if (files.length === 0) return;
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
  const defaultEnvInputs = new Map<string, ConfigInput>();
  const launchEnvInputs = new Map<string, ConfigInput>();
  let selectedUsesLaunch: boolean | undefined;
  const candidates: DirectoryCandidate[] = [];
  const rslibHelpers = options.ownedFederationConfigs ?? new Set<string>();
  let activeBuild = false;
  const claimHelpers = (imports: ConfigImports, ownership: FederationOwnership | undefined) => {
    if (options.ownershipSources) {
      options.ownershipSources.add(path.join(dir, "package.json"));
      imports.addOwnershipSources(options.ownershipSources);
    }
    if (ownership) {
      for (const file of ownership.files)
        rslibHelpers.add(federationClaimKey(file, ownership.name, ownership.origin));
    }
  };
  for (const file of files) {
    const inactive = inactiveRslibFiles.includes(file);
    if (inactive || isRslibConfig(file) || (file === selected && launch?.program === "rslib")) {
      options.ownershipSources?.add(file);
      options.ownershipSources?.add(path.join(dir, "package.json"));
    }
    log.event("trace", "discovery.candidate", { file });
    dependencies?.add(file);
    const federationConfig = isFederationConfig(file);
    let federationKey: string | undefined;
    if (federationConfig && file !== selected) {
      try {
        federationKey = fs.realpathSync.native(file);
      } catch {
        continue;
      }
    }
    let readError: unknown;
    const inputs = new Map(launchInputs);
    const configScope = scopeOf(path.dirname(file));
    const text =
      configScope &&
      readConfigInput(file, CONFIG_INPUT_LIMIT, {
        inputs,
        expectedDirectory: configScope.directory,
        onError: (error) => {
          readError = error;
        },
      });
    if (!configScope || text === null) {
      log.event("trace", "discovery.skipped", {
        file,
        reason: "unreadable-config",
        ...(readError !== undefined && safeError(readError)),
      });
      if (file === selected && !keepIndependentConfigs) return;
      continue;
    }
    const parsed = parseProgram(text, file, log);
    if (!parsed) {
      if (file === selected && !keepIndependentConfigs) return;
      continue;
    }
    // A launcher can select another package's config without importing its dotenv data.
    const allowLocalEnv = launch?.program !== "rslib" || isLaunchPackage(configScope);
    const launcherDirectory = scopeOf(launchFolder)?.directory;
    const configDirectory = withRelatedDirectories(configScope.directory, launcherDirectory);
    const imports = new ConfigImports(
      parsed,
      dependencies,
      log,
      allowLocalEnv,
      inputs,
      configDirectory,
    );
    if (file === selected && selectedIsIgnored) {
      claimHelpers(imports, readRslibDevelopmentHelpers(imports));
      if (keepIndependentConfigs) continue;
      return;
    }
    if (inactive) {
      claimHelpers(imports, readRslibDevelopmentHelpers(imports));
      continue;
    }
    const explicit = file === selected && options.configFile !== undefined && file !== scriptConfig;
    const declaredBundler = /^(rsbuild|rslib|vite|rspack|webpack)\./.exec(path.basename(file))?.[1];
    const bundler =
      file === selected
        ? explicit
          ? (declaredBundler ?? (launch?.program === "rslib" ? undefined : launch?.program))
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
      const activeLaunch = useLaunch ? launch : null;
      const parse = (bundler: string | undefined, rslib: boolean) => {
        const appDir = rslib && file === selected ? launchRoot : dir;
        let candidateMode = activeLaunch ? mode : envMode;
        let env: Record<string, string>;
        if (rslib) {
          const initialNodeEnv = activeLaunch?.env.NODE_ENV || DEFAULT_ENV_MODE;
          const fileMode = activeLaunch ? (activeLaunch.mode ?? initialNodeEnv) : envMode;
          const envDir = activeLaunch?.noEnv
            ? null
            : resolveDirectory(appDir, activeLaunch?.envDir, workspaceRoot, dependencies, inputs);
          try {
            const envScope = envDir === null ? null : scopeOf(envDir);
            const canReadEnv =
              envScope !== null &&
              envScope.packageDir === configScope.packageDir &&
              isLaunchPackage(envScope);
            const fileEnv =
              envDir && canReadEnv
                ? readRslibEnv(
                    envDir,
                    fileMode,
                    dependencies,
                    activeLaunch?.env,
                    inputs,
                    withRelatedDirectories(
                      envScope.directory,
                      configScope.directory,
                      launcherDirectory,
                    ),
                  )
                : {};
            env = { ...activeLaunch?.env, ...fileEnv };
          } catch (error) {
            if (!(error instanceof RslibEnvLimitError)) throw error;
            log.event("warn", "discovery.skipped", { file, reason: "rslib-env-expansion-limit" });
            const candidate: ConfigCandidate = {
              app: null,
              bundler: "rslib",
              federationOwnership: readRslibDevelopmentHelpers(imports),
              port: null,
              outputDir: null,
            };
            return { candidate, env: {}, candidateMode };
          }
          if (env.NODE_ENV === "") delete env.NODE_ENV;
          if (activeLaunch) candidateMode = activeLaunch.mode ?? env.NODE_ENV ?? initialNodeEnv;
        } else if (activeLaunch) {
          env = launchEnv ??= {
            ...(activeLaunch.noEnv
              ? {}
              : readModeEnv(dir, candidateMode, dependencies, launchEnvInputs)),
            ...activeLaunch.env,
          };
          for (const [file, input] of launchEnvInputs) inputs.set(file, input);
        } else {
          env = defaultEnv ??= readModeEnv(dir, candidateMode, dependencies, defaultEnvInputs);
          for (const [file, input] of defaultEnvInputs) inputs.set(file, input);
        }
        const candidate = readConfigCandidate(imports, env, log, {
          mode: candidateMode,
          command: activeLaunch?.command,
          appDir,
          trackRslibOwnership: true,
          viteBase: activeLaunch?.viteBase,
          resolveRslibRoot: (root) => {
            if (scriptRoot === null) return null;
            if (
              (launch?.root && (useLaunch || file === selected)) ||
              root === undefined ||
              root === null
            )
              return appDir;
            return typeof root === "string"
              ? resolveDirectory(
                  appDir,
                  root,
                  workspaceRoot,
                  dependencies,
                  inputs,
                  options.ignoreDirectory,
                )
              : null;
          },
          bundler,
          preferImportedBundler: explicit,
          processEnv:
            activeLaunch?.program === "rsbuild"
              ? { NODE_ENV: defaultNodeEnv, ...env }
              : activeLaunch
                ? viteProcessEnv
                : undefined,
        });
        return { candidate, env, candidateMode };
      };
      const usesRslib = (bundlerHint ?? declaredBundler) === "rslib";
      let { candidate, env, candidateMode } = parse(bundlerHint, usesRslib);
      if (!usesRslib && candidate.bundler === "rslib") {
        ({ candidate, env, candidateMode } = parse("rslib", true));
      }
      if (candidate.app?.bundler === "rslib") {
        dependencies?.add(path.join(candidate.app.folder, DEFAULT_TSCONFIG));
        if (candidate.app.folder !== launchFolder) candidate.app.launchFolder = launchFolder;
        candidate.app.launchEnvironment = {
          envMode: candidateMode,
          env,
          configDirectory,
          ...(!allowLocalEnv && { allowLocalEnv }),
        };
      } else if (useLaunch && candidate.app) {
        // The implicit Rsbuild launch default is only for discovery.
        candidate.app.launchEnvironment = { envMode: mode, env: viteProcessEnv ?? env };
      }
      return candidate;
    };
    let candidate = readCandidate(usesLaunch, bundler);
    if (explicit && launch) {
      if (launch.program === "rslib") {
        if (candidate.bundler === "rslib") {
          selectedUsesLaunch = true;
          candidate = readCandidate(true, "rslib");
        } else if (!declaredBundler && !candidate.importedBundler) {
          const withLaunch = readCandidate(true, "rslib");
          if (!candidate.app || candidate.hasRslibProfile || withLaunch.hasRslibProfile) {
            selectedUsesLaunch = true;
            candidate = withLaunch;
          }
        }
      } else if (candidate.bundler !== "rslib") {
        const withLaunch = readCandidate(true, launch.program);
        // Launch variables can select a different exported factory from the default environment.
        selectedUsesLaunch = (withLaunch.importedBundler ?? candidate.bundler) === launch.program;
        if (selectedUsesLaunch) candidate = withLaunch;
      }
    }
    if (candidate.app) {
      if (candidate.app.generateTypes) {
        const directory = scopeOf(candidate.app.folder)?.directory;
        const manifest = directory && packageManifestInput(candidate.app.folder, directory);
        if (manifest) {
          dependencies?.add(manifest.file);
          inputs.set(manifest.file, manifest);
        }
      }
      // Dynamic or custom DTS builds can load package-local dotenv independently of the dev script.
      if (!candidate.app.bundler && candidate.app.generateTypes)
        trackDtsEnvInputs(
          candidate.app.folder,
          candidate.app.launchEnvironment?.envMode ?? envMode,
          inputs,
          dependencies,
        );
      candidate.app.configInputs = [...inputs.values()];
    }
    if (candidate.bundler === "rslib") {
      const ownership = candidate.federationOwnership;
      claimHelpers(imports, ownership);
      if (candidate.app && ownership) candidate.app.federationHelpers = ownership.files;
      if (candidate.app && options.ignoreDirectory?.(candidate.app.folder)) {
        if (file === selected && !keepIndependentConfigs) return;
        continue;
      }
    } else if (!federationConfig && (usesLaunch || selectedUsesLaunch)) {
      activeBuild = true;
    }
    if (!candidate.app) {
      log.event("trace", "discovery.skipped", {
        file,
        reason: "no-resolved-federation-name-or-options",
      });
      if (file === selected && candidate.bundler === "rslib" && !keepIndependentConfigs) return;
    } else if (file === selected && !keepIndependentConfigs) {
      const app = candidate.app;
      log.event("trace", "discovery.found", { app: app.name, file });
      return () => [app];
    }
    if (claimed && file === selected && usesProjectRoot && candidate.app?.bundler === "rslib") {
      for (const key of rslibProjectKeys(candidate.app)) claimed.add(key);
    }
    if (
      keepIndependentConfigs &&
      usesProjectRoot &&
      file !== selected &&
      candidate.bundler === "rslib"
    )
      continue;
    candidates.push({
      file,
      candidate,
      inputs,
      usesLaunch: usesLaunch || (file === selected && selectedUsesLaunch === true),
      federationKey,
    });
  }
  // A later directory may own a standalone config here. Resolve ownership before merging apps.
  if (candidates.length)
    return (isWorkspaceOwnedConfig) => {
      const directoryCandidates = !claimed
        ? candidates
        : candidates.filter(({ file, candidate, usesLaunch }) => {
            if (file === selected) return true;
            if (
              launch &&
              (candidate.bundler !== "rslib" || (launch.program === "rslib" && usesLaunch))
            )
              return true;
            if (claimed.has(file)) return false;
            const app = candidate.app;
            return (
              app?.bundler !== "rslib" || !rslibProjectKeys(app).some((key) => claimed.has(key))
            );
          });
      const activeHasFederation = directoryCandidates.some(
        ({ candidate, usesLaunch, federationKey }) =>
          !federationKey && usesLaunch && candidate.bundler !== "rslib" && candidate.app,
      );
      const requiresUnownedHelper = ({ federationKey, usesLaunch }: DirectoryCandidate) =>
        federationKey !== undefined && !(activeBuild && !activeHasFederation && usesLaunch);
      const selection = options.resolveOwnershipFor;
      const track =
        selection &&
        !directoryCandidates.some(
          (entry) => entry.candidate.app?.name === selection.name && !requiresUnownedHelper(entry),
        );
      const available = directoryCandidates.filter((entry) => {
        const { federationKey, candidate } = entry;
        const app = candidate.app;
        if (
          federationKey === undefined ||
          !app?.federationNameOrigin ||
          !requiresUnownedHelper(entry)
        )
          return true;
        const { name, federationNameOrigin: origin } = app;
        const key = federationClaimKey(federationKey, name, origin);
        if (rslibHelpers.has(key) || isWorkspaceOwnedConfig?.(federationKey, name, origin))
          return false;
        if (selection && track && name === selection.name) {
          selection.reads.add(key);
        }
        return true;
      });
      return mergeCandidates(dir, available, log);
    };
}

function rslibProjectKeys(app: LocalApp): string[] {
  if (app.launchFolder && !isRslibLauncherAncestor(app.launchFolder, app.folder)) return [];
  try {
    const folder = canonicalDirectoryPath(app.folder);
    const project = `\0${folder}\0${app.name}`;
    const config = fs.realpathSync.native(app.rslibConfigFile ?? app.configFile);
    return [`${project}\0${config}\0${app.federationNameOrigin ?? ""}`, project];
  } catch {
    return [];
  }
}

function mergeCandidates(
  dir: string,
  candidates: DirectoryCandidate[],
  log: LogContext,
): LocalApp[] {
  const apps = new Map<string, LocalApp>();
  const bundlerOutputs: (string | null)[] = [];
  let standaloneZipName: string | undefined;
  let standaloneAppName: string | undefined;
  let standaloneManifestFile: string | undefined;
  let standaloneRsbuildManifestFile: string | undefined;
  let rsbuildBase: string | undefined;
  let viteBase: string | undefined;
  let resolveRsbuildDevManifest: ((file: string) => string | undefined) | undefined;
  const rsbuildApps = new Set<string>();
  const viteApps = new Set<string>();
  const standaloneApps = new Set<string>();
  let loosePort: number | null = null;
  const activeVite = candidates.find(
    ({ file, candidate, usesLaunch }) =>
      usesLaunch && candidate.viteBase !== undefined && !isFederationConfig(file),
  )?.candidate;
  const hasNonRslibLaunch = candidates.some(
    ({ file, candidate, usesLaunch }) =>
      usesLaunch && candidate.bundler !== "rslib" && !isFederationConfig(file),
  );
  for (const { file, candidate, usesLaunch } of candidates) {
    const federationConfig = isFederationConfig(file);
    const {
      app,
      port,
      outputDir,
      bundlerZipName,
      rsbuildBase: base,
      resolveRsbuildDevManifest: resolveDevManifest,
      manifestFile,
      rsbuildManifestFile,
    } = candidate;
    const viteConfig = !federationConfig && candidate.viteBase !== undefined;
    if (candidate.bundler !== "rslib") {
      if (!federationConfig) bundlerOutputs.push(outputDir);
      if (base !== undefined) {
        rsbuildBase = base;
        resolveRsbuildDevManifest = resolveDevManifest;
      }
      if (viteConfig) viteBase = candidate.viteBase;
      if (port !== null) loosePort = port;
    }
    if (!app) continue;
    if (federationConfig && app.bundler !== "rslib") standaloneApps.add(app.name);
    log.event("trace", "discovery.found", { app: app.name, file });
    const existing = apps.get(app.name);
    if (
      !existing ||
      (existing.bundler === "rslib" &&
        app.bundler !== "rslib" &&
        usesLaunch &&
        (!federationConfig || hasNonRslibLaunch))
    ) {
      apps.set(app.name, { ...app });
      if (federationConfig) {
        standaloneAppName = app.name;
        standaloneZipName = bundlerZipName;
        standaloneManifestFile = manifestFile;
        standaloneRsbuildManifestFile = rsbuildManifestFile;
      }
    } else if (
      app.bundler === "rslib" &&
      (usesLaunch ||
        (!hasNonRslibLaunch && isFederationConfig(existing.buildConfigFile ?? existing.configFile)))
    ) {
      apps.set(app.name, { ...app });
    } else if (existing.bundler !== "rslib" && app.bundler !== "rslib") {
      if (existing.port === null && app.port !== null && activeVite?.app?.name !== app.name)
        existing.port = app.port;
      if (candidate === activeVite) {
        existing.port = app.port;
        existing.manifest = app.manifest;
        existing.manifestPath = app.manifestPath;
        delete existing.devManifestPath;
      } else if (
        base !== undefined &&
        !rsbuildApps.has(app.name) &&
        activeVite?.app?.name !== app.name
      ) {
        existing.manifestPath = app.manifestPath;
        if (app.port === null || existing.port === app.port)
          existing.devManifestPath = app.devManifestPath;
      } else if (viteConfig && !rsbuildApps.has(app.name) && !viteApps.has(app.name)) {
        existing.manifest = app.manifest;
        existing.manifestPath = app.manifestPath;
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
    if (base !== undefined && app.bundler !== "rslib") rsbuildApps.add(app.name);
    if (viteConfig) viteApps.add(app.name);
  }
  const standalone = standaloneAppName === undefined ? undefined : apps.get(standaloneAppName);
  let activeStandaloneVite = false;
  if (
    activeVite?.viteBase !== undefined &&
    !activeVite.app &&
    standaloneApps.size === 1 &&
    standalone !== undefined &&
    standalone.bundler !== "rslib" &&
    standaloneManifestFile !== undefined
  ) {
    activeStandaloneVite = true;
    standalone.port = activeVite.port;
    standalone.manifestPath = joinViteManifestPath(activeVite.viteBase, standaloneManifestFile);
    delete standalone.devManifestPath;
  }
  const result = [...apps.values()];
  const nonRslib = result.filter((app) => app.bundler !== "rslib");
  const nonRslibInputs = new Map<string, ConfigInput>();
  for (const { candidate, inputs } of candidates) {
    if (candidate.bundler !== "rslib")
      for (const [file, input] of inputs) nonRslibInputs.set(file, input);
  }
  for (const app of nonRslib) app.configInputs = [...nonRslibInputs.values()];
  if (nonRslib.length === 1) {
    const [app] = nonRslib;
    if (app.port === null && app.name === standaloneAppName && bundlerOutputs.length === 1)
      app.port = loosePort;
    if (
      !activeVite &&
      app.name === standaloneAppName &&
      viteBase !== undefined &&
      standaloneManifestFile !== undefined &&
      bundlerOutputs.length === 1 &&
      !viteApps.has(app.name)
    ) {
      app.manifestPath = joinViteManifestPath(viteBase, standaloneManifestFile);
      delete app.devManifestPath;
    } else if (
      !activeStandaloneVite &&
      standaloneRsbuildManifestFile !== undefined &&
      rsbuildBase !== undefined &&
      bundlerOutputs.length === 1 &&
      !rsbuildApps.has(app.name) &&
      !viteApps.has(app.name)
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
  return result;
}

function resolveDirectory(
  dir: string,
  value: string | undefined,
  workspaceRoot: string,
  dependencies?: Set<string>,
  inputs?: Map<string, ConfigInput>,
  ignoreAlias?: (folder: string) => boolean,
): string | null {
  if (!value) return dir;
  if (value.length > MAX_CONFIG_LOCATION_LENGTH) return null;
  const candidate = path.resolve(dir, value);
  if (!pathIsInside(workspaceRoot, candidate)) return null;
  dependencies?.add(candidate);
  const directory = readConfigDirectory(candidate);
  if (inputs && !inputs.has(candidate)) {
    inputs.set(candidate, {
      file: candidate,
      directorySelection: configDirectoryIdentity(directory),
    });
  }
  if (!directory) return null;
  try {
    const root = canonicalDirectoryPath(workspaceRoot);
    const real = directory.path;
    if (canonicalPathIsInside(root, real)) {
      const resolved = path.join(workspaceRoot, path.relative(root, real));
      dependencies?.add(resolved);
      return candidate === dir || ignoreAlias?.(candidate) ? candidate : resolved;
    }
  } catch {
    // Track the requested directory so creating it invalidates discovery.
  }
  return null;
}

type PackageScope = { directory: ConfigDirectory; packageDir: string };

function withRelatedDirectories(
  target: ConfigDirectory,
  ...directories: (ConfigDirectory | undefined)[]
): ConfigDirectory {
  const related = [...new Set(directories)].filter(
    (directory): directory is ConfigDirectory => directory !== undefined && directory !== target,
  );
  return related.length ? { ...target, related } : target;
}

function packageScope(
  folder: string,
  workspaceRoot: string,
  dependencies?: Set<string>,
): PackageScope | null {
  try {
    const root = canonicalDirectoryPath(workspaceRoot);
    const directory = readConfigDirectory(folder);
    if (!directory || !canonicalPathIsInside(root, directory.path)) return null;
    let packageDir = directory.path;
    const packageMarkers: [string, boolean][] = [];
    while (packageDir !== root) {
      const manifest = path.join(packageDir, "package.json");
      dependencies?.add(manifest);
      const present = Boolean(fs.lstatSync(manifest, { throwIfNoEntry: false }));
      packageMarkers.push([manifest, present]);
      if (present) break;
      const parent = path.dirname(packageDir);
      if (parent === packageDir) return null;
      packageDir = parent;
    }
    return { directory: { ...directory, packageMarkers }, packageDir };
  } catch {
    return null;
  }
}

function resolveConfigFile(
  dir: string,
  specifier: string,
  dependencies?: Set<string>,
): string | null {
  const candidate = path.resolve(dir, specifier);
  const relative = path.relative(dir, candidate);
  const parts = relative.split(path.sep);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    parts.some((part) => part === ".." || part === "node_modules" || part === ".git")
  )
    return null;
  dependencies?.add(candidate);
  try {
    const root = canonicalDirectoryPath(dir);
    let current = root;
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      const entry = fs.lstatSync(current);
      if (index === parts.length - 1 ? !entry.isFile() : !entry.isDirectory()) return null;
    }
    const real = fs.realpathSync.native(candidate);
    if (!CONFIG_EXTENSION.test(real) || !canonicalPathIsInside(root, real)) return null;
    const canonical = path.relative(root, real);
    if (canonical.split(path.sep).some((part) => part === "node_modules" || part === ".git"))
      return null;
    const resolved = path.join(dir, canonical);
    dependencies?.add(resolved);
    return resolved;
  } catch {
    return null;
  }
}
