import path from "node:path";
import { isIndependentRslibProject, type LocalApp } from "../../../entities/microfrontend/index.ts";
import { mergeMissingApps } from "../../../features/init-settings/index.ts";
import { DEFAULT_START_SCRIPT } from "../../../shared/config/project.ts";
import { logDuration } from "../../../shared/lib/logging.ts";
import type { LogContext } from "../../../shared/models/logging.ts";
import type {
  AppSetting,
  DashboardPorts,
  DashboardSettings,
  DiscoveryPlan,
  DiscoverySnapshot,
  WorkspaceRoot,
} from "../models/session-types.ts";
import { appConfigStamp, configFilesStamp, ObservedConfigFiles } from "./app-parse-cache.ts";
import {
  appParseKey,
  claimConfiguredHelpers,
  configSelections,
  createDiscoveryLookups,
  federationOwnershipKey,
  hasConfiguredRslibAlias,
  isRslibProjectFallback,
  previousRslibAlias,
  previousRslibAppLocation,
  sameDiscoveredApp,
  workspaceRelative,
} from "./known-apps.ts";

export function discoveryKey(roots: readonly WorkspaceRoot[], current: DashboardSettings) {
  return JSON.stringify([
    roots,
    current.envMode,
    current.ignorePaths,
    current.startScript ?? DEFAULT_START_SCRIPT,
    current.apps,
  ]);
}

export function discoveredNames({ scans }: DiscoverySnapshot) {
  return [...new Set(scans.flatMap(({ apps }) => Object.keys(apps)))];
}

export function discoveryFilesAreCurrent({ checks }: Pick<DiscoverySnapshot, "checks">): boolean {
  return checks.every(({ dependencies, stamp }) => stamp === configFilesStamp(dependencies));
}

export function prepareDiscoverySnapshot(
  roots: readonly WorkspaceRoot[],
  current: DashboardSettings,
  scan: DashboardPorts["scan"],
  log: LogContext,
): DiscoverySnapshot {
  const started = Date.now();
  const startScript = current.startScript ?? DEFAULT_START_SCRIPT;
  const selectionDependencies = new ObservedConfigFiles();
  const selections = configSelections(
    roots,
    Object.entries(current.apps ?? {}),
    startScript,
    current.ignorePaths,
    selectionDependencies,
  );
  const ownedFederationConfigs = new Set<string>();
  const ownershipSources = new Set<string>();
  const prepared = roots.map((root) => {
    const dependencies = new ObservedConfigFiles();
    const apps = scan(
      root.path,
      {
        envMode: current.envMode,
        ignorePaths: current.ignorePaths,
        startScript,
        dependencies,
        ownershipSources,
        log,
      },
      ownedFederationConfigs,
    );
    const inputs = [...dependencies];
    return {
      root,
      apps,
      dependencies: inputs,
      stamp: configFilesStamp(inputs, dependencies.observations),
    };
  });
  claimConfiguredHelpers(
    selections,
    current.envMode,
    selectionDependencies,
    ownedFederationConfigs,
    ownershipSources,
  );
  const scans = prepared.map(({ root, apps }) => ({
    root,
    apps: typeof apps === "function" ? apps() : apps,
  }));
  const checks = prepared.map(({ dependencies, stamp }) => ({ dependencies, stamp }));
  if (selectionDependencies.size) {
    const dependencies = [...selectionDependencies];
    checks.push({
      dependencies,
      stamp: configFilesStamp(dependencies, selectionDependencies.observations),
    });
  }
  const ownershipKey =
    roots.length > 1 || selections.length
      ? federationOwnershipKey(roots, selections, current.envMode, startScript, current.ignorePaths)
      : undefined;
  const parsed: DiscoverySnapshot["parsed"] = new Map();
  for (const { root, apps } of scans) {
    for (const [name, app] of Object.entries(apps)) {
      const key = appParseKey(
        root.path,
        app.launchFolder ?? app.folder,
        current.envMode,
        name,
        startScript,
        undefined,
        current.ignorePaths,
        ownershipKey,
      );
      parsed.set(key, {
        app,
        stamp: appConfigStamp(app.launchFolder ?? app.folder, current.envMode, app.configFile),
      });
    }
  }
  const snapshot = { key: discoveryKey(roots, current), scans, checks, parsed };
  logDuration(
    log,
    "discovery.prepare.completed",
    started,
    {
      roots: roots.length,
      apps: discoveredNames(snapshot).length,
    },
    "info",
  );
  return snapshot;
}

export function planDiscovery(
  roots: readonly WorkspaceRoot[],
  current: DashboardSettings,
  previous: DiscoverySnapshot | undefined,
  scan: DashboardPorts["scan"],
  log: LogContext,
): DiscoveryPlan {
  const key = discoveryKey(roots, current);
  const discovered =
    previous?.key === key &&
    discoveryFilesAreCurrent(previous) &&
    [...previous.parsed.values()].every(
      ({ app, stamp }) =>
        stamp === appConfigStamp(app.launchFolder ?? app.folder, current.envMode, app.configFile),
    )
      ? previous
      : prepareDiscoverySnapshot(roots, current, scan, log);
  const cache = { parsed: discovered.parsed, checks: discovered.checks };
  if (!roots.length) return { cache };
  const startScript = current.startScript ?? DEFAULT_START_SCRIPT;
  const selected = new Map<string, { root: WorkspaceRoot; app: LocalApp }>();
  for (const { root, apps: found } of discovered.scans) {
    for (const [name, app] of Object.entries(found)) {
      const previous = selected.get(name)?.app;
      if (previous) {
        const keepDirectProject = isIndependentRslibProject(app, previous);
        if (
          sameDiscoveredApp(previous, app) ||
          isIndependentRslibProject(previous, app) ||
          (!keepDirectProject && isRslibProjectFallback(app, previous, startScript))
        )
          continue;
        if (!keepDirectProject && !isRslibProjectFallback(previous, app, startScript)) {
          return { duplicateName: name };
        }
      }
      selected.set(name, { root, app });
    }
  }
  const foundApps: Record<string, AppSetting> = Object.create(null);
  const migrations = new Set<string>();
  const migratedAliases = new Set<string>();
  const lookups = createDiscoveryLookups(current.envMode);
  for (const [name, { root, app }] of selected) {
    let saved = Object.hasOwn(current.apps ?? {}, name) ? current.apps?.[name] : undefined;
    if (
      !Object.hasOwn(current.apps ?? {}, name) &&
      hasConfiguredRslibAlias(roots, current.apps ?? {}, app, current.envMode, startScript, lookups)
    )
      continue;
    foundApps[name] = {
      path: workspaceRelative(root.path, app.launchFolder ?? app.folder),
      ...(roots.length > 1 ? { workspaceFolder: root.name } : {}),
    };
    let previousFolder =
      saved &&
      previousRslibAppLocation(
        roots,
        saved,
        app,
        root.path,
        current.envMode,
        startScript,
        name,
        lookups,
      );
    if (!saved && (app.launchFolder || app.federationHelpers?.length)) {
      const alias = previousRslibAlias(
        roots,
        current.apps ?? {},
        app,
        root.path,
        current.envMode,
        startScript,
        lookups,
      );
      if (alias) {
        saved = alias.entry;
        previousFolder = alias.folder;
        migratedAliases.add(alias.key);
      }
    }
    if (saved && previousFolder) {
      foundApps[name] = { ...saved, ...foundApps[name] };
      const zip = typeof saved.typesZipPath === "string" ? saved.typesZipPath.trim() : "";
      if (zip && !path.isAbsolute(zip)) {
        const absoluteZip = path.resolve(previousFolder, zip);
        let relativeZip = workspaceRelative(app.folder, absoluteZip);
        // Rebuild trims the setting before resolving it, so protect whitespace in names.
        if (/^\s/.test(relativeZip)) relativeZip = `./${relativeZip}`;
        if (/\s$/.test(relativeZip)) relativeZip = `${relativeZip}/.`;
        foundApps[name].typesZipPath = relativeZip;
      }
      migrations.add(name);
    }
  }
  const apps = mergeMissingApps(current.apps, foundApps);
  for (const alias of migratedAliases) {
    if (Object.hasOwn(foundApps, alias)) apps[alias] = foundApps[alias];
    else delete apps[alias];
  }
  for (const name of migrations) apps[name] = foundApps[name];
  const changed =
    migrations.size > 0 ||
    Object.keys(foundApps).some((name) => !Object.hasOwn(current.apps ?? {}, name));
  return { cache, ...(changed && { apps }) };
}
