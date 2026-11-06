import fs from "node:fs";
import path from "node:path";
import {
  confirmInstalledArchive,
  installTypesArchive,
  type InstallTypesResult,
} from "../../entities/federated-types/index.ts";
import { resolveTypesPath, typesPathEscape } from "../../entities/federated-types/destination.ts";
import type { LocalApp } from "../../entities/microfrontend/index.ts";
import { fillTemplate } from "../../shared/shell.ts";
import { DiagnosticError } from "../../shared/diagnostic-error.ts";

const REFETCH_TIMEOUT_MS = 60_000;
const SCOPED_ALIAS = /^@[\w-](?:[\w.-]*[\w-])?\/[\w-](?:[\w.-]*[\w-])?$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
type TypesConsumer = Pick<LocalApp, "folder" | "typesFolder" | "remotes" | "consumeTypes">;
type Remote = LocalApp["remotes"][number];
type TypesRoot = { folder: string; real: string };
type PathEntry = { file: string; link?: { id: string; parent?: string; listed: boolean } };

export function refetchTarget(
  consumerFolder: string,
  remoteAlias: string,
  typesFolder: string,
): string {
  return resolveRefetchTarget(consumerFolder, remoteAlias, typesFolder).destination;
}

export function dependencyTypesTarget(
  consumer: TypesConsumer,
  remote: Remote,
  consumers: readonly TypesConsumer[],
): string {
  const route = new Set<string>();
  const { destination, root } = resolveRefetchTarget(
    consumer.folder,
    remote.alias,
    consumer.typesFolder,
    route,
  );
  assertDistinctTarget(root, route, remote, consumers);
  return destination;
}

function resolveRefetchTarget(
  consumerFolder: string,
  remoteAlias: string,
  typesFolder: string,
  route?: Set<string>,
) {
  if (!safeAlias(remoteAlias))
    throw new DiagnosticError(`unsafe remote alias: ${remoteAlias}`, {
      stage: "destination",
      reason: "unsafe-alias",
    });
  const scoped = remoteAlias.includes("/");
  const root = resolveTypesRoot(consumerFolder, typesFolder, route);
  const destination = path.resolve(root.folder, remoteAlias);
  if (
    scoped &&
    fs.lstatSync(path.dirname(destination), { throwIfNoEntry: false })?.isSymbolicLink()
  )
    throw typesPathEscape("types scope directory is a symlink");
  resolveTypesPath(scoped ? root.folder : consumerFolder, destination);
  return { destination, root };
}

export function typesRootTarget(consumerFolder: string, typesFolder: string): string {
  return resolveTypesRoot(consumerFolder, typesFolder).folder;
}

function resolveTypesRoot(
  consumerFolder: string,
  typesFolder: string,
  route?: Set<string>,
): TypesRoot {
  assertRelativeFolder(typesFolder);
  const folder = path.resolve(consumerFolder, typesFolder);
  return { folder, real: resolveTypesPath(consumerFolder, folder, route) };
}

export function dependencyRefetchCommand(
  template: string,
  consumer: LocalApp,
  remote: Remote,
  consumers: readonly TypesConsumer[],
): string {
  return fillTemplate(template, {
    folder: consumer.folder,
    name: consumer.name,
    port: consumer.port == null ? "" : String(consumer.port),
    tsconfig: consumer.tsconfig ?? "",
    typesFolder: dependencyTypesTarget(consumer, remote, consumers),
  });
}

export async function refetchInstalled(input: {
  consumerFolder: string;
  remoteAlias: string;
  typesFolder: string;
  url: string;
  command: string;
  timeoutMs?: number;
  runCommand?: (command: string, cwd: string, timeoutMs: number) => Promise<number>;
  beforeReplace?: () => void;
}): Promise<InstallTypesResult> {
  const destination = refetchTarget(input.consumerFolder, input.remoteAlias, input.typesFolder);
  const timeoutMs = input.timeoutMs ?? REFETCH_TIMEOUT_MS;
  const command = input.command.trim();
  if (command === "") {
    return installTypesArchive({
      url: input.url,
      destination,
      appDir: input.consumerFolder,
      timeoutMs,
      beforeReplace: input.beforeReplace,
    });
  }
  const run = input.runCommand;
  if (!run) throw new Error("refetch command is not runnable");
  const code = await run(command, input.consumerFolder, timeoutMs);
  if (code !== 0)
    throw new DiagnosticError(`refetch command exited ${code}`, {
      stage: "shell",
      reason: "shell-exit",
      exitCode: code,
    });
  return confirmInstalledArchive({
    url: input.url,
    destination,
    appDir: input.consumerFolder,
    timeoutMs,
  });
}

function safeAlias(alias: string): boolean {
  const slash = alias.indexOf("/");
  return (
    alias !== "" &&
    alias !== "." &&
    alias !== ".." &&
    (slash === -1 || (SCOPED_ALIAS.test(alias) && !WINDOWS_DEVICE.test(alias.slice(slash + 1)))) &&
    !alias.includes("\\") &&
    !alias.includes("\0") &&
    !/^[a-z]:/i.test(alias) &&
    !path.isAbsolute(alias)
  );
}

function typesPathKey(file: string): string {
  if (process.platform === "win32") return file.replace(/[. ]+$/, "").toLowerCase();
  return process.platform === "darwin" ? file.toLowerCase() : file;
}

function existingEntry(file: string): PathEntry {
  try {
    const stat = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) {
      const name = path.basename(file);
      let parent: string | undefined;
      let listed = false;
      try {
        parent = fs.realpathSync.native(path.dirname(file));
        listed = stat.nlink > 1n && fs.readdirSync(parent).includes(name);
      } catch {
        // Retain the link identity even if the directory cannot be listed.
      }
      return {
        file: parent === undefined ? file : path.join(parent, name),
        link: { id: `${stat.dev}:${stat.ino}`, parent, listed },
      };
    }
    if (stat) return { file: fs.realpathSync.native(file) };
  } catch {
    // Keep the configured spelling when another alias cannot be resolved.
  }
  return { file };
}

function targetPaths(root: TypesRoot, alias: string) {
  const entry = existingEntry(path.resolve(root.real, alias));
  const paths = [root.folder, root.real].flatMap((folder) => [
    { file: path.resolve(folder, alias) },
    { file: path.resolve(folder, alias.toLowerCase()) },
  ]);
  return { entry, paths: [...paths, entry] };
}

function sameLink(first: PathEntry, second: PathEntry): boolean {
  if (!first.link || first.link.id !== second.link?.id) return false;
  if (first.file === second.file) return true;
  const { parent, listed } = first.link;
  if (parent !== undefined && second.link.parent !== undefined && parent !== second.link.parent)
    return false;
  // Only a pair of actual directory entries proves these are distinct names.
  return !listed || !second.link.listed;
}

function replacesPath(
  targets: readonly PathEntry[],
  references: readonly PathEntry[],
  allowEqual = false,
): boolean {
  return targets.some((target) => {
    const key = typesPathKey(target.file);
    return references.some((reference) => {
      const file = typesPathKey(reference.file);
      return (
        (!allowEqual && (file === key || sameLink(target, reference))) ||
        file.startsWith(`${key}${path.sep}`)
      );
    });
  });
}

function replacesRoute(targets: readonly PathEntry[], route: readonly PathEntry[]): boolean {
  // A replacement directory still satisfies a traversal through that exact directory.
  return route.some((entry) => replacesPath(targets, [entry], entry.link === undefined));
}

function replacesLinkedAlias(
  targets: readonly PathEntry[],
  consumer: TypesConsumer,
  root: TypesRoot,
  alias: string,
  shared: boolean,
): boolean {
  const route = new Set<string>();
  let file: string;
  try {
    file = resolveTypesPath(consumer.folder, path.resolve(root.folder, alias), route);
  } catch {
    return false;
  }
  const backing = [{ file }];
  return (
    replacesPath(targets, backing, shared) ||
    replacesPath(backing, targets, shared) ||
    replacesRoute(targets, Array.from(route, existingEntry))
  );
}

function assertDistinctTarget(
  targetRoot: TypesRoot,
  targetRoute: ReadonlySet<string>,
  remote: Remote,
  consumers: readonly TypesConsumer[],
): void {
  const { alias } = remote;
  const target = targetPaths(targetRoot, alias);
  const route = Array.from(targetRoute, existingEntry);
  const scoped = alias.includes("/");
  for (const consumer of consumers) {
    if (!consumer.consumeTypes) continue;
    const remotes = consumer.remotes.filter(
      ({ alias }) => (scoped || alias.includes("/")) && safeAlias(alias),
    );
    if (!remotes.length) continue;
    let root: TypesRoot;
    const otherRoute = new Set<string>();
    try {
      root = resolveTypesRoot(consumer.folder, consumer.typesFolder, otherRoute);
    } catch {
      continue;
    }
    const references = Array.from(otherRoute, existingEntry);
    for (const other of remotes) {
      const candidate = targetPaths(root, other.alias);
      const shared =
        other.alias === alias && other.name === remote.name && other.url === remote.url;
      const sharedEntry =
        shared &&
        (target.entry.file === candidate.entry.file || sameLink(target.entry, candidate.entry));
      if (
        replacesPath(target.paths, candidate.paths, shared) ||
        replacesPath(candidate.paths, target.paths, shared) ||
        replacesRoute(target.paths, references) ||
        replacesRoute(candidate.paths, route) ||
        (!sharedEntry && replacesLinkedAlias(target.paths, consumer, root, other.alias, shared))
      )
        throw new DiagnosticError(`remote aliases share a types directory: ${alias}`, {
          stage: "destination",
          reason: "unsafe-alias",
        });
    }
  }
}

function assertRelativeFolder(typesFolder: string): void {
  if (typesFolder === "" || typesFolder.includes("\0") || path.isAbsolute(typesFolder)) {
    throw new DiagnosticError("unsafe types folder", {
      stage: "destination",
      reason: "unsafe-types-folder",
    });
  }
  if (typesFolder.split(/[\\/]/).includes(".."))
    throw new DiagnosticError("unsafe types folder", {
      stage: "destination",
      reason: "path-escape",
    });
}
