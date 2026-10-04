import fs from "node:fs";
import path from "node:path";
import {
  confirmInstalledArchive,
  installTypesArchive,
  type InstallTypesResult,
} from "../../entities/federated-types/index.ts";
import { fillTemplate } from "../../shared/shell.ts";
import { DiagnosticError } from "../../shared/diagnostic-error.ts";

const REFETCH_TIMEOUT_MS = 60_000;

export function refetchTarget(
  consumerFolder: string,
  remoteAlias: string,
  typesFolder: string,
): string {
  assertAlias(remoteAlias);
  const consumer = path.resolve(consumerFolder);
  const typesRoot = typesRootTarget(consumer, typesFolder);
  const destination = path.resolve(typesRoot, remoteAlias);
  assertInside(consumer, destination);
  assertNoSymlinkEscape(consumer, destination);
  return destination;
}

export function typesRootTarget(consumerFolder: string, typesFolder: string): string {
  assertRelativeFolder(typesFolder);
  const consumer = path.resolve(consumerFolder);
  const typesRoot = path.resolve(consumer, typesFolder);
  assertInside(consumer, typesRoot);
  assertNoSymlinkEscape(consumer, typesRoot);
  return typesRoot;
}

export function dependencyRefetchCommand(
  template: string,
  target: {
    folder: string;
    name: string;
    port: number | null;
    tsconfig: string | null;
    typesFolder: string;
    alias: string;
  },
): string {
  return fillTemplate(template, {
    folder: target.folder,
    name: target.name,
    port: target.port == null ? "" : String(target.port),
    tsconfig: target.tsconfig ?? "",
    typesFolder: refetchTarget(target.folder, target.alias, target.typesFolder),
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

function assertAlias(alias: string): void {
  if (
    alias === "" ||
    alias === "." ||
    alias === ".." ||
    alias.includes("/") ||
    alias.includes("\\") ||
    alias.includes("\0") ||
    path.isAbsolute(alias)
  ) {
    throw new DiagnosticError(`unsafe remote alias: ${alias}`, {
      stage: "destination",
      reason: "unsafe-alias",
    });
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

function assertInside(root: string, target: string): void {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === "..")
    throw new DiagnosticError("types path escapes the consumer", {
      stage: "destination",
      reason: "path-escape",
    });
  if (rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
    throw new DiagnosticError("types path escapes the consumer", {
      stage: "destination",
      reason: "path-escape",
    });
}

function assertNoSymlinkEscape(root: string, target: string): void {
  if (!fs.existsSync(root)) return;
  const rootReal = fs.realpathSync(root);
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel.startsWith("..") || path.isAbsolute(rel))
    throw new DiagnosticError("types path escapes the consumer", {
      stage: "destination",
      reason: "path-escape",
    });
  let current = path.resolve(root);
  for (const part of rel.split(path.sep)) {
    if (part === "" || part === ".") continue;
    current = path.join(current, part);
    if (!fs.existsSync(current)) return;
    const real = fs.realpathSync(current);
    const fromRoot = path.relative(rootReal, real);
    if (fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
      throw new DiagnosticError("types path escapes the consumer", {
        stage: "destination",
        reason: "path-escape",
      });
    }
  }
}
