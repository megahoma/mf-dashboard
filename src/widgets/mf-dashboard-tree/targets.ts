import { localManifestUrl, parseHttpUrl } from "../../shared/urls.ts";
export { localManifestUrl } from "../../shared/urls.ts";
import { statSync } from "node:fs";
import type { LocalApp } from "../../entities/microfrontend/index.ts";
import { refetchTarget, typesRootTarget } from "../../features/refetch-types/refetch.ts";

export interface RowActionInput {
  configFile: string | null;
  producerConfigFile: string | null;
  typesDir: string | null;
  manifestUrl: string | null;
}

export interface RowAction {
  configFile: string | null;
  producerConfigFile: string | null;
  typesDir: string | null;
  manifestUrl: string | null;
  tokens: string[];
}

export function linkTypesDir(folder: string, alias: string, typesFolder: string): string | null {
  try {
    return refetchTarget(folder, alias, typesFolder);
  } catch {
    return null;
  }
}

function appTypesDir(folder: string, typesFolder: string): string | null {
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
): RowAction | null {
  if (typeof node !== "object" || node === null) return null;
  const { id, name, linkId } = node as { id?: unknown; name?: unknown; linkId?: unknown };
  if (typeof id !== "string" || typeof name !== "string") return null;
  if (typeof linkId === "string") {
    const parts = linkId.split("\0");
    if (parts.length !== 3) return null;
    const [consumerName, alias, remoteName] = parts;
    const consumer = apps.find((app) => app.name === consumerName);
    const remote = consumer?.remotes.find(
      (item) => item.alias === alias && item.name === remoteName,
    );
    if (!consumer || !remote || name !== remoteName) return null;
    const producer = apps.find((app) => app.name === remoteName);
    return rowAction({
      configFile: consumer.configFile,
      producerConfigFile: producer?.configFile ?? null,
      typesDir: linkTypesDir(consumer.folder, alias, consumer.typesFolder),
      manifestUrl: remote.url,
    });
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
  const app = apps.find((item) => item.name === name && id === `app:${item.name}`);
  if (!app) return null;
  return rowAction({
    configFile: app.configFile,
    producerConfigFile: null,
    typesDir: appTypesDir(app.folder, app.typesFolder),
    manifestUrl:
      app.manifest && app.port != null ? localManifestUrl(app.port, app.manifestPath) : null,
  });
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
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
