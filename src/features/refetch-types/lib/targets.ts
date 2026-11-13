import fs from "node:fs";
import path from "node:path";
import { resolveTypesPath, typesPathEscape } from "../../../entities/federated-types/index.ts";
import { DiagnosticError } from "../../../shared/models/diagnostic-error.ts";
import { SCOPED_ALIAS, WINDOWS_DEVICE } from "../config/refetch.ts";
import type { PathEntry, Remote, TypesConsumer, TypesRoot } from "../models/refetch.ts";

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
