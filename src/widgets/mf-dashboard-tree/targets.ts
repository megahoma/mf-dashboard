import { statSync } from "node:fs";
import { refetchTarget } from "../../features/refetch-types/refetch.ts";

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

export function localManifestUrl(port: number, manifestPath: string): string {
  const pathName = manifestPath.startsWith("/") ? manifestPath : `/${manifestPath}`;
  return `http://127.0.0.1:${port}${pathName}`;
}

export function linkTypesDir(folder: string, alias: string, typesFolder: string): string | null {
  try {
    return refetchTarget(folder, alias, typesFolder);
  } catch {
    return null;
  }
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
  if (url == null) return null;
  const trimmed = url.trim();
  if (trimmed === "" || trimmed.includes("${")) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.hostname === "") return null;
    return trimmed;
  } catch {
    return null;
  }
}
