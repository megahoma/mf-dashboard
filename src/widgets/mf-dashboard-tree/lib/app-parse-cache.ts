import fs from "node:fs";
import path from "node:path";
import { FEDERATION_CONFIG_PREFIX, type LocalApp } from "../../../entities/microfrontend/index.ts";
import { noLog } from "../../../shared/config/logging.ts";
import { configFileStamp, configFilesStamp } from "../../../shared/lib/config-files-stamp.ts";
import { modeEnvFiles } from "../../../shared/lib/env-files.ts";
import { isTypeScriptSource, pathIsInside } from "../../../shared/lib/paths.ts";
import type { LogContext } from "../../../shared/models/logging.ts";
import type { AppParseCache, KnownAppsTask, OwnershipSnapshot } from "../models/session-types.ts";

export { configFilesStamp } from "../../../shared/lib/config-files-stamp.ts";

export function savedFileKind(
  app: Pick<
    LocalApp,
    | "folder"
    | "configFile"
    | "configDependencies"
    | "ownershipSources"
    | "generateTypes"
    | "launchEnvironment"
  >,
  file: string,
  envMode: string,
): "config" | "source" | null {
  const folder = path.resolve(app.folder);
  const full = path.resolve(file);
  if (app.configDependencies?.includes(full) || app.ownershipSources?.has(full)) return "config";
  if (!pathIsInside(folder, full)) return null;
  if (full === path.resolve(app.configFile)) return "config";
  if (path.dirname(full) === folder) {
    const name = path.basename(full);
    if (name === "package.json") return "config";
    if (FEDERATION_CONFIG_PREFIX.test(name)) return "config";
    if (
      [envMode, app.launchEnvironment?.envMode].some(
        (mode) => mode !== undefined && modeEnvFiles(mode).includes(name),
      )
    )
      return "config";
  }
  return app.generateTypes && isTypeScriptSource(full) ? "source" : null;
}

export function appConfigStamp(
  folder: string,
  envMode: string,
  configFile: string | null,
  dependencies: readonly string[] = [],
  observations?: ReadonlyMap<string, string>,
): string {
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(folder)
      .filter((name) => FEDERATION_CONFIG_PREFIX.test(name))
      .sort();
  } catch {
    /* A removed folder invalidates its cached parse. */
  }
  const files = [
    ...names.map((name) => path.join(folder, name)),
    ...modeEnvFiles(envMode).map((name) => path.join(folder, name)),
    ...dependencies,
  ];
  if (configFile) files.push(configFile);
  return configFilesStamp(files, observations);
}

export class ObservedConfigFiles extends Set<string> {
  readonly observations = new Map<string, string>();

  constructor(files: Iterable<string> = []) {
    super();
    for (const file of files) this.add(file);
  }

  override add(file: string): this {
    if (!this.has(file)) this.observations.set(file, configFileStamp(file));
    return super.add(file);
  }
}

export function createAppParseCache(log: LogContext = noLog): AppParseCache {
  const stored = new Map<
    string,
    {
      stamp: string;
      app: LocalApp | null;
      dependencies: readonly string[];
      ownership?: OwnershipSnapshot;
    }
  >();
  const ownershipByRoot = new Map<string, OwnershipSnapshot>();
  const cache: AppParseCache = {
    lookup(...args) {
      return cache.lookupResult(...args) ?? null;
    },
    lookupResult(key, folder, envMode, ownershipUnchanged) {
      const hit = stored.get(key);
      const stamp = hit
        ? appConfigStamp(folder, envMode, hit.app?.configFile ?? null, hit.dependencies)
        : "";
      if (!hit || hit.stamp !== stamp) {
        log.event("debug", "config.cache.miss", () => {
          const oldRows = new Set(hit?.stamp.split("\n") ?? []);
          const newRows = new Set(stamp.split("\n"));
          const changed = [...oldRows, ...newRows]
            .filter((row) => !oldRows.has(row) || !newRows.has(row))
            .map((row) => row.split("\0")[0]);
          const kinds = [
            ...new Set(
              changed.map((file) =>
                path.basename(file).startsWith(".env.")
                  ? "env-changed"
                  : FEDERATION_CONFIG_PREFIX.test(path.basename(file))
                    ? "root-config-changed"
                    : "import-dependency-changed",
              ),
            ),
          ];
          return { folder, reason: hit ? kinds.join(",") : "not-cached" };
        });
        return undefined;
      }
      if (hit.ownership && !ownershipUnchanged?.(hit.ownership)) {
        log.event("debug", "config.cache.miss", { folder, reason: "ownership-changed" });
        return undefined;
      }
      log.event("debug", "config.cache.hit", { folder });
      return hit.app;
    },
    store(key, folder, envMode, app, dependencies = [], ownership, observations) {
      stored.set(key, {
        stamp: appConfigStamp(folder, envMode, app?.configFile ?? null, dependencies, observations),
        app,
        dependencies: [...dependencies],
        ownership,
      });
    },
    lookupOwnership: (key) => ownershipByRoot.get(key),
    storeOwnership: (key, snapshot) => {
      ownershipByRoot.set(key, snapshot);
    },
    ownershipIsCurrent: (snapshot) => configFilesStamp(snapshot.dependencies) === snapshot.stamp,
  };
  return cache;
}

export function withDiscoveryCache(
  cache: AppParseCache,
  discovery?: KnownAppsTask["discovery"],
): AppParseCache {
  if (
    !discovery ||
    !discovery.checks.every(({ dependencies, stamp }) => configFilesStamp(dependencies) === stamp)
  )
    return cache;
  return {
    ...cache,
    lookupResult(key, folder, envMode, ownershipUnchanged) {
      const hit = discovery.parsed.get(key);
      if (hit && hit.stamp === appConfigStamp(folder, envMode, hit.app.configFile)) return hit.app;
      return cache.lookupResult(key, folder, envMode, ownershipUnchanged);
    },
  };
}
