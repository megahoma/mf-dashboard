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
  const links = new Set<string>();
  const { destination, root } = resolveRefetchTarget(
    consumer.folder,
    remote.alias,
    consumer.typesFolder,
    links,
  );
  assertDistinctTarget(root, links, remote, consumers);
  return destination;
}

function resolveRefetchTarget(
  consumerFolder: string,
  remoteAlias: string,
  typesFolder: string,
  links?: Set<string>,
) {
  if (!safeAlias(remoteAlias))
    throw new DiagnosticError(`unsafe remote alias: ${remoteAlias}`, {
      stage: "destination",
      reason: "unsafe-alias",
    });
  const scoped = remoteAlias.includes("/");
  const root = resolveTypesRoot(consumerFolder, typesFolder, links);
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
  links?: Set<string>,
): TypesRoot {
  assertRelativeFolder(typesFolder);
  const folder = path.resolve(consumerFolder, typesFolder);
  return { folder, real: resolveTypesPath(consumerFolder, folder, links) };
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

function targetPaths(root: TypesRoot, alias: string): string[] {
  return [root.folder, root.real].flatMap((folder) => [
    typesPathKey(path.resolve(folder, alias)),
    typesPathKey(path.resolve(folder, alias.toLowerCase())),
  ]);
}

function replacesPath(
  targets: readonly string[],
  references: readonly string[],
  shared = false,
): boolean {
  return targets.some((target) =>
    references.some(
      (file) => (!shared && file === target) || file.startsWith(`${target}${path.sep}`),
    ),
  );
}

function assertDistinctTarget(
  targetRoot: TypesRoot,
  targetLinks: ReadonlySet<string>,
  remote: Remote,
  consumers: readonly TypesConsumer[],
): void {
  const { alias } = remote;
  const targets = targetPaths(targetRoot, alias);
  const links = Array.from(targetLinks, typesPathKey);
  const scoped = alias.includes("/");
  for (const consumer of consumers) {
    if (!consumer.consumeTypes) continue;
    const remotes = consumer.remotes.filter(
      ({ alias }) => (scoped || alias.includes("/")) && safeAlias(alias),
    );
    if (!remotes.length) continue;
    let root: TypesRoot;
    const otherLinks = new Set<string>();
    try {
      root = resolveTypesRoot(consumer.folder, consumer.typesFolder, otherLinks);
    } catch {
      continue;
    }
    const references = Array.from(otherLinks, typesPathKey);
    for (const other of remotes) {
      const candidates = targetPaths(root, other.alias);
      const shared =
        other.alias === alias && other.name === remote.name && other.url === remote.url;
      if (
        replacesPath(targets, candidates, shared) ||
        replacesPath(candidates, targets, shared) ||
        replacesPath(targets, references) ||
        replacesPath(candidates, links)
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
