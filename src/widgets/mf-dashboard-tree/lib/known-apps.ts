import fs from "node:fs";
import path from "node:path";
import {
  federationClaimKey,
  isIgnoredDirectory,
  isRslibLauncherAncestor,
  isRslibProjectForLauncher,
  prepareAppFolder,
  prepareConfigSelection,
  readAppFolder,
  readPackageScripts,
  readWorkspaceFederationHelpers,
  type ConfigSelection,
  type FederationOwnershipCheck,
  type LocalApp,
} from "../../../entities/microfrontend/index.ts";
import { resolveManifestPath } from "../../../features/init-settings/index.ts";
import { rebuildConfigFingerprint } from "../../../features/rebuild-types/index.ts";
import { lookupScript } from "../../../features/start-app/index.ts";
import { noLog } from "../../../shared/config/logging.ts";
import { DEFAULT_START_SCRIPT } from "../../../shared/config/project.ts";
import { sha256 } from "../../../shared/lib/fingerprint.ts";
import { resolveLogFields } from "../../../shared/lib/logging.ts";
import { canonicalPathIsInside, pathIsInside } from "../../../shared/lib/paths.ts";
import type { LogContext } from "../../../shared/models/logging.ts";
import { LocatedError, type SourceProblem } from "../../../shared/models/source-problem.ts";
import type {
  AppParseCache,
  AppSetting,
  OwnershipSnapshot,
  WorkspaceRoot,
} from "../models/session-types.ts";
import { configFilesStamp, createAppParseCache, ObservedConfigFiles } from "./app-parse-cache.ts";

export function loadKnownApps(
  roots: readonly WorkspaceRoot[],
  apps: Record<string, AppSetting>,
  envMode: string,
  ignorePaths: readonly string[] = [],
  cache: AppParseCache = createAppParseCache(),
  log: LogContext = noLog,
  startScript = DEFAULT_START_SCRIPT,
  ownershipSources?: Set<string>,
): LocalApp[] {
  return [
    ...resolveKnownApps(
      roots,
      apps,
      envMode,
      cache,
      log,
      undefined,
      startScript,
      ignorePaths,
      ownershipSources,
    ).values(),
  ];
}

export function appParseKey(
  root: string,
  folder: string,
  envMode: string,
  name: string,
  script: string,
  configFile?: string,
  ignorePaths: readonly string[] = [],
  ownershipKey?: string,
): string {
  return JSON.stringify([
    root,
    folder,
    envMode,
    name,
    script,
    configFile,
    ignorePaths,
    ownershipKey,
  ]);
}

export function resolveKnownApps(
  roots: readonly WorkspaceRoot[],
  apps: Record<string, AppSetting>,
  envMode: string,
  cache: AppParseCache = createAppParseCache(),
  log: LogContext = noLog,
  onError?: (name: string, error: unknown) => void,
  startScript = DEFAULT_START_SCRIPT,
  ignorePaths: readonly string[] = [],
  ownershipSources?: Set<string>,
  captureRebuildConfig = false,
): Map<string, LocalApp> {
  const entries: { name: string; app: LocalApp; identity: string; hasOverride: boolean }[] = [];
  const matches = new Map<string, number>();
  const settings = Object.entries(apps);
  const selectionDependencies = new ObservedConfigFiles();
  const configuredOwners = configSelections(
    roots,
    settings,
    startScript,
    ignorePaths,
    selectionDependencies,
  );
  const ownershipKey = federationOwnershipKey(
    roots,
    configuredOwners,
    envMode,
    startScript,
    ignorePaths,
  );
  let workspaceHelpers: OwnershipSnapshot | undefined;
  const readOwnership = () => {
    if (workspaceHelpers) return workspaceHelpers;
    let snapshot = cache.lookupOwnership(ownershipKey);
    if (!snapshot || !cache.ownershipIsCurrent(snapshot)) {
      const inputs = selectionDependencies;
      const files = new Set<string>();
      const sources = new Set<string>();
      for (const root of roots) {
        const helpers = readWorkspaceFederationHelpers(root.path, {
          envMode,
          startScript,
          ignorePaths,
          dependencies: inputs,
          log,
        });
        for (const file of helpers.files) files.add(file);
        for (const source of helpers.sources) sources.add(source);
      }
      claimConfiguredHelpers(configuredOwners, envMode, inputs, files, sources);
      const dependencies = [...inputs];
      snapshot = {
        files,
        sources,
        dependencies,
        stamp: configFilesStamp(dependencies, inputs.observations),
      };
      cache.storeOwnership(ownershipKey, snapshot);
    }
    workspaceHelpers = snapshot;
    if (ownershipSources) for (const file of snapshot.sources) ownershipSources.add(file);
    return snapshot;
  };
  for (const [name, setting] of settings) {
    if (!setting || typeof setting.path !== "string" || setting.path.trim() === "") continue;
    const candidates = setting.workspaceFolder
      ? roots.filter((root) => root.name === setting.workspaceFolder)
      : roots;
    const script = typeof setting.scripts?.start === "string" ? setting.scripts.start : startScript;
    const configFile = typeof setting.configFile === "string" ? setting.configFile : undefined;
    const problems: SourceProblem[] = [];
    const configLog: LogContext = captureRebuildConfig
      ? {
          ...log,
          event(level, event, fields) {
            if (event === "discovery.skipped") {
              const detail = resolveLogFields(fields);
              if (
                detail?.reason === "syntax-error" &&
                typeof detail.file === "string" &&
                typeof detail.line === "number"
              ) {
                const code = typeof detail.reasonCode === "string" ? detail.reasonCode : undefined;
                problems.push({
                  file: detail.file,
                  line: detail.line,
                  column: typeof detail.column === "number" ? detail.column + 1 : 1,
                  message: code ? `Config syntax error (${code})` : "Config syntax error",
                });
              }
            }
            log.event(level, event, fields);
          },
        }
      : log;
    const before = entries.length;
    try {
      for (const root of candidates) {
        const confined = confinedAppPath(root.path, setting.path);
        if (!confined) {
          log.event("warn", "config.path.invalid", { app: name });
          continue;
        }
        const { absolute, canonical } = confined;
        const rootPath = path.resolve(root.path);
        const key = appParseKey(
          root.path,
          absolute,
          envMode,
          name,
          script,
          configFile,
          ignorePaths,
          roots.length > 1 || configuredOwners.length ? ownershipKey : undefined,
        );
        const cached = cache.lookupResult(
          key,
          absolute,
          envMode,
          (previous) => previous === readOwnership(),
        );
        const dependencies = new ObservedConfigFiles();
        let ownership: OwnershipSnapshot | undefined;
        let app = cached;
        if (app === undefined) {
          const parsed = readAppFolder(
            absolute,
            envMode,
            name,
            dependencies,
            configLog,
            script,
            configFile,
            (file, name, origin) => {
              ownership ??= readOwnership();
              return ownership.files.has(federationClaimKey(file, name, origin));
            },
            rootPath,
          );
          const configDependencies = [...dependencies];
          const appOwnershipSources = ownership?.sources;
          app = parsed && {
            ...parsed,
            configDependencies,
            ...(appOwnershipSources?.size && { ownershipSources: appOwnershipSources }),
          };
          if (app && captureRebuildConfig) {
            app.rebuildConfigStamp = rebuildConfigFingerprint(app, dependencies.observations, true);
          }
          cache.store(
            key,
            absolute,
            envMode,
            app,
            configDependencies,
            ownership,
            dependencies.observations,
          );
        }
        if (!app) continue;
        if (app.name !== name && candidates.length !== 1) continue;
        const identity = `${canonical}\0${app.name}`;
        matches.set(identity, (matches.get(identity) ?? 0) + 1);
        const resolved = withManifestPathOverride(app, setting.manifestPath);
        resolved.settingsKey = name;
        entries.push({
          name,
          app: resolved,
          identity,
          hasOverride: configFile !== undefined || script !== startScript,
        });
        break;
      }
    } catch (error) {
      if (!onError) throw error;
      onError(name, error);
    }
    if (entries.length === before && problems.length) {
      onError?.(name, new LocatedError("Could not read the microfrontend config", problems));
    }
  }
  const launched = new Map(
    entries
      .filter(({ name, app }) => name === app.name && app.launchFolder && app.rslibConfigFile)
      .map(({ name, app }) => [name, app]),
  );
  const loaded = new Map<string, LocalApp>();
  for (const { name, app, identity, hasOverride } of entries) {
    const launcher = launched.get(app.name);
    if (
      name !== app.name &&
      !hasOverride &&
      launcher &&
      isRslibProjectFallback(app, launcher, startScript)
    )
      continue;
    if (name === app.name || matches.get(identity) === 1) loaded.set(name, app);
  }
  return loaded;
}

export function federationOwnershipKey(
  roots: readonly WorkspaceRoot[],
  selections: readonly ConfiguredSelection[],
  envMode: string,
  startScript: string,
  ignorePaths: readonly string[],
): string {
  return sha256(
    JSON.stringify([
      roots.map((root) => path.resolve(root.path)),
      selections,
      envMode,
      startScript,
      ignorePaths,
    ]),
  );
}

type ConfiguredSelection = {
  name?: string;
  candidates: (ConfigSelection & { claim: boolean })[];
};

export function configSelections(
  roots: readonly WorkspaceRoot[],
  settings: readonly [string, AppSetting][],
  defaultScript: string,
  ignorePaths: readonly string[],
  dependencies: Set<string>,
): ConfiguredSelection[] {
  const selections: ConfiguredSelection[] = [];
  for (const [name, setting] of settings) {
    if (!setting || typeof setting.path !== "string" || !setting.path.trim()) continue;
    const startScript =
      typeof setting.scripts?.start === "string" ? setting.scripts.start : defaultScript;
    const configFile = typeof setting.configFile === "string" ? setting.configFile : undefined;
    const hasOverride = startScript !== defaultScript || configFile !== undefined;
    const candidates = setting.workspaceFolder
      ? roots.filter((root) => root.name === setting.workspaceFolder)
      : roots;
    const choices: ConfiguredSelection["candidates"] = [];
    const paths: string[] = [];
    for (const root of candidates) {
      paths.push(path.resolve(root.path, setting.path));
      const confined = confinedAppPath(root.path, setting.path);
      if (!confined) continue;
      const folder = confined.absolute;
      const workspaceRoot = path.resolve(root.path);
      const claim =
        hasOverride || confined.aliased || isIgnoredDirectory(workspaceRoot, folder, ignorePaths);
      choices.push({
        folder,
        startScript,
        configFile,
        workspaceRoot,
        claim,
      });
    }
    if (!choices.some(({ claim }) => claim)) continue;
    selections.push({ name: candidates.length > 1 ? name : undefined, candidates: choices });
    for (const file of paths) dependencies.add(file);
  }
  return selections;
}

export function claimConfiguredHelpers(
  selections: readonly ConfiguredSelection[],
  envMode: string,
  dependencies: Set<string>,
  files: Set<string>,
  sources: Set<string>,
): void {
  // Prepare all choices first, then resolve them against ownership across every workspace root.
  const prepared = selections.map(({ name, candidates }) => ({
    name,
    candidates: candidates.map((candidate) => {
      const helpers = new Set<string>();
      const inputs = new Set<string>();
      const reads = new Set<string>();
      const resolve = prepareConfigSelection(
        candidate,
        envMode,
        dependencies,
        helpers,
        inputs,
        (file, name, origin) => files.has(federationClaimKey(file, name, origin)),
        name === undefined ? undefined : { name, reads },
      );
      return { candidate, helpers, inputs, reads, resolve };
    }),
  }));
  for (const { name, candidates } of prepared) {
    for (const { helpers, inputs } of candidates) {
      for (const file of inputs) dependencies.add(file);
      if (name !== undefined) continue;
      for (const helper of helpers) files.add(helper);
      for (const file of inputs) sources.add(file);
    }
  }
  let pending = prepared.filter(({ name }) => name !== undefined);
  while (pending.length) {
    const claims = new Map<string, Set<(typeof pending)[number]>>();
    const selected = pending.map((selection) => {
      let match: (typeof selection.candidates)[number] | undefined;
      // Ownership can hide the current match and let a later workspace folder take its place.
      for (const entry of selection.candidates) {
        entry.reads.clear();
        if (!entry.resolve?.().some(({ name }) => name === selection.name)) continue;
        match ??= entry;
        if (entry.candidate.claim) {
          for (const helper of entry.helpers) {
            const owners = claims.get(helper) ?? new Set();
            owners.add(selection);
            claims.set(helper, owners);
          }
        }
        if (entry.reads.size === 0) break;
      }
      return { selection, match };
    });
    // A match remains available as long as one of its standalone configs remains unclaimed.
    const ready = selected.filter(
      ({ selection, match }) =>
        !match?.reads.size ||
        [...match.reads].some((file) => {
          const owners = claims.get(file);
          // A later candidate cannot displace the current match through its own claim.
          return !owners || (owners.size === 1 && owners.has(selection));
        }),
    );
    // Mutually dependent fallbacks have no independently established owner.
    if (!ready.length) break;
    for (const { match } of ready) {
      if (!match?.candidate.claim) continue;
      for (const helper of match.helpers) files.add(helper);
      for (const file of match.inputs) sources.add(file);
    }
    const resolved = new Set(ready.map(({ selection }) => selection));
    pending = pending.filter((selection) => !resolved.has(selection));
  }
}

function withManifestPathOverride(app: LocalApp, configuredPath: string | undefined): LocalApp {
  const override = resolveManifestPath(configuredPath, "");
  return override ? { ...app, manifestPath: override, devManifestPath: undefined } : { ...app };
}

function confinedAppPath(
  root: string,
  settingPath: string,
  canonicalPath = realPath,
): { absolute: string; canonical: string; aliased: boolean } | null {
  const base = path.resolve(root);
  const absolute = path.resolve(base, settingPath);
  if (!pathIsInside(base, absolute)) return null;
  try {
    if (!fs.existsSync(absolute)) return { absolute, canonical: absolute, aliased: false };
    const canonical = canonicalPath(absolute);
    const canonicalRoot = canonicalPath(base);
    if (
      canonical === null ||
      canonicalRoot === null ||
      !canonicalPathIsInside(canonicalRoot, canonical)
    )
      return null;
    const aliased = path.relative(canonicalRoot, canonical) !== path.relative(base, absolute);
    return { absolute, canonical, aliased };
  } catch {
    return null;
  }
}

export function workspaceRelative(root: string, folder: string): string {
  const relative = path.relative(root, folder);
  if (relative === "") return ".";
  return relative.split(path.sep).join("/");
}

export function sameDiscoveredApp(
  first: LocalApp,
  second: LocalApp,
  filesMatch = sameFile,
): boolean {
  const samePath = (left: string, right: string) => left === right || filesMatch(left, right);
  return (
    first.bundler === second.bundler &&
    samePath(first.folder, second.folder) &&
    samePath(first.launchFolder ?? first.folder, second.launchFolder ?? second.folder) &&
    samePath(first.configFile, second.configFile) &&
    samePath(
      first.rslibConfigFile ?? first.buildConfigFile ?? first.configFile,
      second.rslibConfigFile ?? second.buildConfigFile ?? second.configFile,
    )
  );
}

export function isRslibProjectFallback(
  project: LocalApp,
  launcher: LocalApp,
  startScript: string,
): boolean {
  return (
    isRslibProjectForLauncher(project, launcher, sameFile) &&
    hasNoStartScript(project.folder, startScript)
  );
}

function hasNoStartScript(folder: string, script: string): boolean {
  const scripts = readPackageScripts(folder);
  return scripts !== null && lookupScript(scripts, script) === null;
}

export function createDiscoveryLookups(envMode: string) {
  const prepared = new Map<string, ReturnType<typeof prepareAppFolder>>();
  const confined = new Map<string, ReturnType<typeof confinedAppPath>>();
  const paths = new Map<string, string | null>();
  const canonicalPath = (file: string) => {
    const cached = paths.get(file);
    if (cached !== undefined) return cached;
    const canonical = realPath(file);
    paths.set(file, canonical);
    if (canonical !== null && !paths.has(canonical)) paths.set(canonical, canonical);
    return canonical;
  };
  const readApp = (
    { folder, workspaceRoot, startScript, configFile }: ConfigSelection,
    name: string,
    ownsConfig?: FederationOwnershipCheck,
  ) => {
    // Names and ownership affect selection after the configs have been parsed.
    const key = JSON.stringify([folder, workspaceRoot, startScript, configFile]);
    let resolve = prepared.get(key);
    if (!resolve) {
      resolve = prepareAppFolder(
        folder,
        envMode,
        undefined,
        noLog,
        startScript,
        configFile,
        workspaceRoot,
      );
      prepared.set(key, resolve);
    }
    return resolve(name, ownsConfig);
  };
  return {
    readApp,
    confinedAppPath(root: string, settingPath: string) {
      const key = JSON.stringify([root, settingPath]);
      const cached = confined.get(key);
      if (cached !== undefined) return cached;
      const entry = confinedAppPath(root, settingPath, canonicalPath);
      confined.set(key, entry);
      return entry;
    },
    sameFile: (first: string, second: string) => sameFile(first, second, canonicalPath),
  };
}

export function previousRslibAppLocation(
  roots: readonly WorkspaceRoot[],
  setting: AppSetting,
  app: LocalApp,
  ownerRoot: string,
  envMode: string,
  defaultScript: string,
  settingsKey = app.name,
  lookups = createDiscoveryLookups(envMode),
): string | undefined {
  const helpers = app.federationHelpers;
  if (app.launchFolder && !isRslibLauncherAncestor(app.launchFolder, app.folder)) return;
  if (
    (!helpers?.length && !app.launchFolder) ||
    !setting ||
    typeof setting.path !== "string" ||
    !setting.path.trim() ||
    typeof setting.configFile === "string"
  )
    return;
  const script = typeof setting.scripts?.start === "string" ? setting.scripts.start : defaultScript;
  const candidates = setting.workspaceFolder
    ? roots.filter((root) => root.name === setting.workspaceFolder)
    : roots;
  const matches = candidates
    .flatMap(({ path: workspaceRoot }) => {
      const entry = lookups.confinedAppPath(workspaceRoot, setting.path);
      return entry ? [{ ...entry, workspaceRoot }] : [];
    })
    .flatMap((entry) => {
      const saved = lookups.readApp(
        { folder: entry.absolute, workspaceRoot: entry.workspaceRoot, startScript: script },
        settingsKey,
      );
      return saved?.name === app.name && (settingsKey === app.name || candidates.length === 1)
        ? [{ ...entry, saved }]
        : [];
    });
  const [previous, ...otherMatches] = matches;
  if (!previous || previous.absolute === (app.launchFolder ?? app.folder)) return;
  // Use the first matching root, as Refresh does, when the other roots reach the same app.
  if (
    otherMatches.some(
      ({ canonical, saved }) =>
        canonical !== previous.canonical ||
        !sameDiscoveredApp(previous.saved, saved, lookups.sameFile),
    )
  )
    return;
  const sameProject =
    app.launchFolder !== undefined &&
    previous.saved.bundler === "rslib" &&
    !previous.saved.launchFolder &&
    previous.saved.folder === previous.absolute &&
    lookups.sameFile(previous.canonical, app.folder) &&
    previous.saved.rslibConfigFile &&
    app.rslibConfigFile &&
    lookups.sameFile(previous.saved.rslibConfigFile, app.rslibConfigFile) &&
    previous.saved.federationNameOrigin === app.federationNameOrigin;
  if (sameProject) {
    if (script === defaultScript && hasNoStartScript(previous.absolute, script))
      return previous.absolute;
    return;
  }
  if (
    !app.federationNameOrigin ||
    previous.saved.federationNameOrigin !== app.federationNameOrigin ||
    !helpers?.some((file) => path.dirname(file) === previous.canonical)
  )
    return;
  const configured = lookups.readApp(
    { folder: previous.absolute, workspaceRoot: previous.workspaceRoot, startScript: script },
    settingsKey,
    (file, name, origin) =>
      name === app.name && origin === app.federationNameOrigin && helpers.includes(file),
  );
  if (configured && (configured.name === app.name || settingsKey !== app.name)) return;
  if (script === defaultScript) return previous.absolute;
  const replacement = lookups.readApp(
    { folder: app.launchFolder ?? app.folder, workspaceRoot: ownerRoot, startScript: script },
    app.name,
  );
  if (replacement?.name === app.name && replacement.bundler === "rslib") return previous.absolute;
}

export function previousRslibAlias(
  roots: readonly WorkspaceRoot[],
  settings: Readonly<Record<string, AppSetting>>,
  app: LocalApp,
  ownerRoot: string,
  envMode: string,
  defaultScript: string,
  lookups = createDiscoveryLookups(envMode),
) {
  const aliases = Object.entries(settings).flatMap(([key, entry]) => {
    const folder = previousRslibAppLocation(
      roots,
      entry,
      app,
      ownerRoot,
      envMode,
      defaultScript,
      key,
      lookups,
    );
    return folder ? [{ key, entry, folder }] : [];
  });
  return aliases.length === 1 ? aliases[0] : undefined;
}

export function hasConfiguredRslibAlias(
  roots: readonly WorkspaceRoot[],
  settings: Readonly<Record<string, AppSetting>>,
  app: LocalApp,
  envMode: string,
  defaultScript: string,
  lookups = createDiscoveryLookups(envMode),
): boolean {
  if (!app.rslibConfigFile) return false;
  const locations = new Map<
    string,
    { key: string; folder: string; workspaceRoot: string; script: string; configFile?: string }[]
  >();
  for (const [key, setting] of Object.entries(settings)) {
    if (key === app.name || typeof setting?.path !== "string" || !setting.path.trim()) continue;
    const configFile = typeof setting.configFile === "string" ? setting.configFile : undefined;
    const script =
      typeof setting.scripts?.start === "string" ? setting.scripts.start : defaultScript;
    const candidates = setting.workspaceFolder
      ? roots.filter((root) => root.name === setting.workspaceFolder)
      : roots;
    // A renamed app is only eligible for configured loading with an unambiguous workspace.
    if (candidates.length !== 1) continue;
    const workspaceRoot = candidates[0].path;
    const confined = lookups.confinedAppPath(workspaceRoot, setting.path);
    if (!confined) continue;
    const group = locations.get(confined.canonical) ?? [];
    group.push({ key, folder: confined.absolute, workspaceRoot, script, configFile });
    locations.set(confined.canonical, group);
  }
  const project = app.launchFolder ? realPath(app.folder) : null;
  const launcher = app.launchFolder ? realPath(app.launchFolder) : null;
  const independent =
    project !== null && launcher !== null && !canonicalPathIsInside(launcher, project);
  for (const [canonical, group] of locations) {
    const sameLaunch = lookups.sameFile(canonical, app.launchFolder ?? app.folder);
    const independentProject = independent && canonical === project;
    const usesExistingStart =
      !sameLaunch &&
      lookups.sameFile(canonical, app.folder) &&
      !hasNoStartScript(group[0].folder, defaultScript);
    if (
      !sameLaunch &&
      !usesExistingStart &&
      !independentProject &&
      app.launchFolder !== undefined &&
      group.every(({ script, configFile }) => script === defaultScript && configFile === undefined)
    )
      continue;
    let matching = 0;
    let eligible = false;
    for (const { folder, key, script, configFile, workspaceRoot } of group) {
      const parsed = lookups.readApp(
        { folder, workspaceRoot, startScript: script, configFile },
        key,
        (file, name, origin) =>
          name === app.name &&
          origin === app.federationNameOrigin &&
          (app.federationHelpers?.includes(file) ?? false),
      );
      if (parsed?.name !== app.name) continue;
      // The loader needs one matching alias per canonical location and federation name.
      if (++matching > 1) break;
      if (parsed.rslibConfigFile !== undefined) {
        eligible =
          (sameLaunch ||
            usesExistingStart ||
            isRslibProjectForLauncher(app, parsed, lookups.sameFile) ||
            (independentProject &&
              lookups.sameFile(parsed.rslibConfigFile, app.rslibConfigFile) &&
              parsed.federationNameOrigin === app.federationNameOrigin) ||
            script !== defaultScript ||
            configFile !== undefined) &&
          lookups.sameFile(parsed.folder, app.folder);
      } else if (
        configFile !== undefined &&
        app.federationNameOrigin &&
        parsed.federationNameOrigin === app.federationNameOrigin
      ) {
        const entry = path.resolve(folder, configFile);
        eligible = app.federationHelpers?.some((file) => lookups.sameFile(entry, file)) ?? false;
      }
    }
    if (matching === 1 && eligible) return true;
  }
  return false;
}

function sameFile(first: string, second: string, canonicalPath = realPath): boolean {
  const real = canonicalPath(first);
  return real !== null && real === canonicalPath(second);
}

function realPath(file: string): string | null {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return null;
  }
}
