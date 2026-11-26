import fs from "node:fs";
import {
  indexedApps,
  splitRemoteLinkKey,
  type LocalApp,
} from "../../../entities/microfrontend/index.ts";
import { refetchTarget, typesRootTarget } from "../../../features/refetch-types/index.ts";
import { localManifestUrl, parseHttpUrl } from "../../../shared/lib/urls.ts";
import type { RowAction, RowActionInput, TypesDirectoryLookup } from "../models/targets.ts";

export function linkTypesDir(folder: string, alias: string, typesFolder: string): string | null {
  try {
    return refetchTarget(folder, alias, typesFolder);
  } catch {
    return null;
  }
}

export function appTypesDir(folder: string, typesFolder: string): string | null {
  try {
    return typesRootTarget(folder, typesFolder);
  } catch {
    return null;
  }
}

export function resolveRowAction(
  node: unknown,
  apps: readonly LocalApp[],
  extraUrls: readonly string[],
  cachedTypesDirectory?: TypesDirectoryLookup,
): RowAction | null {
  if (typeof node !== "object" || node === null) return null;
  const { id, name, linkId } = node as { id?: unknown; name?: unknown; linkId?: unknown };
  if (typeof id !== "string" || typeof name !== "string") return null;
  const byName = indexedApps(apps);
  const typesDirectory: TypesDirectoryLookup =
    cachedTypesDirectory ??
    ((app, alias) =>
      alias === undefined
        ? appTypesDir(app.folder, app.typesFolder)
        : linkTypesDir(app.folder, alias, app.typesFolder));
  const isDirectory = cachedTypesDirectory ? () => true : directoryExists;
  if (typeof linkId === "string") {
    const parts = splitRemoteLinkKey(linkId);
    if (parts.length !== 3) return null;
    const [consumerName, alias, remoteName] = parts;
    const consumer = byName.get(consumerName);
    const remote = consumer?.remotes.find(
      (item) => item.alias === alias && item.name === remoteName,
    );
    if (!consumer || !remote || name !== remoteName) return null;
    const producer = byName.get(remoteName);
    return rowAction(
      {
        configFile: consumer.configFile,
        producerConfigFile: producer?.configFile ?? null,
        typesDir: typesDirectory(consumer, alias),
        manifestUrl: remote.url,
      },
      isDirectory,
    );
  }
  if (linkId != null) return null;
  if (id.startsWith("extra:")) {
    const url = id.slice("extra:".length);
    if (!extraUrls.includes(url)) return null;
    return rowAction({
      configFile: null,
      producerConfigFile: null,
      typesDir: null,
      manifestUrl: url,
    });
  }
  const app = byName.get(name);
  if (!app || id !== `app:${app.name}`) return null;
  return rowAction(
    {
      configFile: app.configFile,
      producerConfigFile: null,
      typesDir: typesDirectory(app),
      manifestUrl:
        app.manifest && app.port != null ? localManifestUrl(app.port, app.manifestPath) : null,
    },
    isDirectory,
  );
}

export function directoryExists(path: string): boolean {
  try {
    return fs.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function rowAction(
  input: RowActionInput,
  isDirectory: (path: string) => boolean = directoryExists,
): RowAction {
  const configFile = input.configFile?.trim() || null;
  const producerConfigFile =
    input.producerConfigFile &&
    input.producerConfigFile.trim() !== "" &&
    input.producerConfigFile.trim() !== configFile
      ? input.producerConfigFile.trim()
      : null;
  const typesDir =
    input.typesDir && input.typesDir.trim() !== "" && isDirectory(input.typesDir)
      ? input.typesDir
      : null;
  const manifestUrl = httpManifestUrl(input.manifestUrl);
  const tokens = [
    configFile ? "config" : null,
    producerConfigFile ? "producer" : null,
    typesDir ? "types" : null,
    manifestUrl ? "manifest" : null,
  ].filter((token): token is string => token !== null);
  return { configFile, producerConfigFile, typesDir, manifestUrl, tokens };
}

export function withActionTokens(contextValue: string, tokens: readonly string[]): string {
  if (tokens.length === 0) return contextValue;
  return `${contextValue} ${tokens.join(" ")}`;
}

function httpManifestUrl(url: string | null): string | null {
  return url != null && parseHttpUrl(url) ? url.trim() : null;
}
