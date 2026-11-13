import fs from "node:fs";
import path from "node:path";
import { FEDERATION_CONFIG_PREFIX, type LocalApp } from "../../../entities/microfrontend/index.ts";
import { noLog } from "../../../shared/config/logging.ts";
import { modeEnvFiles } from "../../../shared/lib/env-files.ts";
import { isTypeScriptSource, pathIsInside } from "../../../shared/lib/paths.ts";
import type { LogContext } from "../../../shared/models/logging.ts";
import type { AppParseCache } from "../models/session-types.ts";

export function savedFileKind(
  app: Pick<
    LocalApp,
    "folder" | "configFile" | "configDependencies" | "generateTypes" | "launchEnvironment"
  >,
  file: string,
  envMode: string,
): "config" | "source" | null {
  const folder = path.resolve(app.folder);
  const full = path.resolve(file);
  if (app.configDependencies?.includes(full)) return "config";
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
  return configFilesStamp(files);
}

export function configFilesStamp(files: readonly string[]): string {
  return [...new Set(files)]
    .sort()
    .map((file) => {
      try {
        const stat = fs.statSync(file);
        const directory = stat.isDirectory()
          ? `\0directory\0${stat.ctimeMs}\0${stat.ino}\0${stat.mode}`
          : "";
        return `${file}\0${fs.realpathSync(file)}\0${stat.size}\0${stat.mtimeMs}${directory}`;
      } catch {
        return `${file}\0missing`;
      }
    })
    .join("\n");
}

export function createAppParseCache(log: LogContext = noLog): AppParseCache {
  const stored = new Map<
    string,
    { stamp: string; app: LocalApp; dependencies: readonly string[] }
  >();
  return {
    lookup(key, folder, envMode) {
      const hit = stored.get(key);
      const stamp = hit
        ? appConfigStamp(folder, envMode, hit.app.configFile, hit.dependencies)
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
        return null;
      }
      log.event("debug", "config.cache.hit", { folder });
      return hit.app;
    },
    store(key, folder, envMode, app, dependencies = []) {
      stored.set(key, {
        stamp: appConfigStamp(folder, envMode, app.configFile, dependencies),
        app,
        dependencies: [...dependencies],
      });
    },
  };
}
