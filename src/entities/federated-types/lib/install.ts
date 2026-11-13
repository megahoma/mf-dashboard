import fs from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { noLog } from "../../../shared/config/logging.ts";
import { filesFingerprint, sha256 } from "../../../shared/lib/fingerprint.ts";
import { readLimitedBody } from "../../../shared/lib/http-body.ts";
import { createKeyedLock } from "../../../shared/lib/queue.ts";
import { hasZipPrefix } from "../../../shared/lib/zip.ts";
import { DiagnosticError } from "../../../shared/models/diagnostic-error.ts";
import type { LogContext } from "../../../shared/models/logging.ts";
import { DEFAULT_TIMEOUT_MS } from "../config/install.ts";
import type {
  ArchiveComparison,
  InstallTypesInput,
  InstallTypesResult,
  ZipArchive,
} from "../models/install.ts";
import { checkedArchive, fingerprintArchive, resolveAdmZip, unzipError } from "./archive.ts";
import { resolveTypesPath, typesPathEscape } from "./destination.ts";
import { readInstalledEvidenceAsync, runEvidenceTask } from "./evidence-worker-client.mts";
import { assertTreeInside, readTree } from "./types-tree.ts";

const destinationLock = createKeyedLock();

// Download, check, then swap. The live types directory is not removed before the archive checks out.
export async function installTypesArchive(input: InstallTypesInput): Promise<InstallTypesResult> {
  const target = installTarget(input);
  return destinationLock(path.resolve(input.destination), async () =>
    writeTypesArchive(target, await loadZip(input), input.beforeReplace),
  );
}

export async function installLocalTypesArchive(
  input: Pick<InstallTypesInput, "destination" | "appDir" | "beforeReplace"> & {
    zipPath: string;
    expectedZipHash: string;
    confirmedFilesFingerprint?: string;
  },
): Promise<InstallTypesResult & { changed: boolean }> {
  const target = installTarget(input);
  return destinationLock(path.resolve(input.destination), async () => {
    const bytes = await readFile(input.zipPath);
    const zipHash = sha256(bytes);
    if (zipHash !== input.expectedZipHash)
      throw new DiagnosticError("unzip: local ZIP changed during the update", {
        stage: "archive",
        reason: "fingerprint-mismatch",
      });
    target.verify();
    const { filesFingerprint: fingerprint } = await readInstalledEvidenceAsync(
      target.path,
      undefined,
      true,
    );
    const hasFiles = fingerprint && fingerprint !== filesFingerprint([]);
    if (hasFiles && fingerprint === input.confirmedFilesFingerprint) {
      target.verify();
      return { zipHash, filesFingerprint: fingerprint, changed: false };
    }
    const archive = checkedArchive(bytes, input.appDir);
    if (hasFiles && fingerprint === (await fingerprintArchive(archive))) {
      target.verify();
      return { zipHash, filesFingerprint: fingerprint, changed: false };
    }
    const installed = writeTypesArchive(target, { archive, zipHash }, input.beforeReplace);
    return { ...installed, changed: true };
  });
}

function installTarget({ appDir, destination }: Pick<InstallTypesInput, "appDir" | "destination">) {
  const consumer = fs.realpathSync.native(appDir);
  const absolute = path.resolve(destination);
  const parent = path.dirname(absolute);
  const resolveParent = () => resolveTypesPath(appDir, parent);
  const directory = resolveParent();
  const changed = () => typesPathEscape("types destination changed during installation");
  const directoryId = (folder: string) => {
    const stat = fs.statSync(folder, { bigint: true, throwIfNoEntry: false });
    return stat ? `${stat.dev}:${stat.ino}` : undefined;
  };
  let original = directoryId(directory);
  let anchor = directory;
  let anchorId = original;
  while (anchorId === undefined) {
    if (path.relative(consumer, anchor) === "") throw changed();
    anchor = path.dirname(anchor);
    anchorId = directoryId(anchor);
  }
  return {
    path: path.join(directory, path.basename(absolute)),
    verify() {
      if (
        fs.realpathSync.native(appDir) !== consumer ||
        resolveParent() !== directory ||
        directoryId(anchor) !== anchorId
      )
        throw changed();
      const current = anchor === directory ? anchorId : directoryId(directory);
      if (original !== undefined && current !== original) throw changed();
      original ??= current;
    },
  };
}

function writeTypesArchive(
  target: ReturnType<typeof installTarget>,
  loaded: { archive: ZipArchive; zipHash: string },
  beforeReplace?: () => void,
): InstallTypesResult {
  const destination = target.path;
  const parent = path.dirname(destination);
  // Keep validation and filesystem changes together after the asynchronous ZIP work.
  target.verify();
  fs.mkdirSync(parent, { recursive: true });
  target.verify();
  const staging = fs.mkdtempSync(path.join(parent, ".install-"));
  const backup = `${destination}.backup-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let parked = false;
  try {
    loaded.archive.extractTo(staging);
    target.verify();
    assertTreeInside(staging);
    const fingerprint = filesFingerprint(readTree(staging));
    beforeReplace?.();
    target.verify();
    if (fs.lstatSync(destination, { throwIfNoEntry: false })) {
      fs.renameSync(destination, backup);
      parked = true;
    }
    fs.renameSync(staging, destination);
    if (parked) fs.rmSync(backup, { recursive: true, force: true });
    return { zipHash: loaded.zipHash, filesFingerprint: fingerprint };
  } catch (error) {
    target.verify();
    if (
      parked &&
      !fs.lstatSync(destination, { throwIfNoEntry: false }) &&
      fs.lstatSync(backup, { throwIfNoEntry: false })
    )
      fs.renameSync(backup, destination);
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      // Keep the installation error if staging cleanup fails.
    }
    throw unzipError(error);
  }
}

// A custom command is not trusted: compare the directory to the zip and do not delete it on failure.
export function confirmInstalledArchive(input: InstallTypesInput): Promise<InstallTypesResult> {
  return destinationLock(path.resolve(input.destination), () => checkInstalledArchive(input));
}

async function checkInstalledArchive(input: InstallTypesInput): Promise<InstallTypesResult> {
  const loaded = await loadZip(input);
  const result = await compareArchive(input, {
    zipHash: loaded.zipHash,
    filesFingerprint: await fingerprintArchive(loaded.archive),
  });
  if (!result.matches)
    throw new DiagnosticError("unzip: installed files do not match the archive", {
      stage: "destination",
      reason: "fingerprint-mismatch",
    });
  return { zipHash: result.zipHash, filesFingerprint: result.filesFingerprint };
}

// Verify an external install without changing the consumer's files.
export function compareInstalledArchive(input: InstallTypesInput): Promise<ArchiveComparison> {
  return createArchiveComparisonBatch()(input);
}

// Share outcomes for this refresh, including failures; archive bytes are released after each task.
export function createArchiveComparisonBatch(
  log: LogContext = noLog,
): typeof compareInstalledArchive {
  const archives = new Map<string, Promise<InstallTypesResult>>();
  return (input) =>
    destinationLock(path.resolve(input.destination), async () => {
      const key = JSON.stringify([input.url, input.expectedZipHash ?? ""]);
      let archive = archives.get(key);
      if (!archive) {
        // Decoder availability belongs to this consumer, before any shared archive work begins.
        resolveAdmZip(input.appDir);
        archive = (async () => {
          const buffer = await loadZipBytes(input);
          const zipHash = sha256(buffer);
          if (input.expectedZipHash && zipHash !== input.expectedZipHash)
            throw new DiagnosticError("unzip: archive changed since probe", {
              stage: "archive",
              reason: "fingerprint-mismatch",
            });
          const filesFingerprint = await runEvidenceTask<string>(
            { kind: "archive", bytes: buffer, appDir: input.appDir },
            log,
          );
          return { zipHash, filesFingerprint };
        })();
        archives.set(key, archive);
      }
      return compareArchive(input, await archive, log);
    });
}

async function compareArchive(
  input: InstallTypesInput,
  loaded: InstallTypesResult,
  log: LogContext = noLog,
): Promise<ArchiveComparison> {
  const destination = path.resolve(input.destination);
  if (!fs.existsSync(destination) || !fs.statSync(destination).isDirectory()) {
    throw new DiagnosticError("unzip: types directory is missing", {
      stage: "destination",
      reason: "directory-missing",
    });
  }
  const installed = await readInstalledEvidenceAsync(destination, log, true);
  const fingerprint = installed.filesFingerprint;
  if (fingerprint === filesFingerprint([]))
    throw new DiagnosticError("unzip: types directory is empty", {
      stage: "destination",
      reason: "directory-empty",
    });
  if (!fingerprint) throw new Error("unzip: could not read types directory");
  return {
    zipHash: loaded.zipHash,
    filesFingerprint: fingerprint,
    matches: fingerprint === loaded.filesFingerprint,
  };
}

async function loadZip(
  input: InstallTypesInput,
): Promise<{ archive: ZipArchive; zipHash: string }> {
  const buffer = await loadZipBytes(input);
  return { archive: checkedArchive(buffer, input.appDir), zipHash: sha256(buffer) };
}

async function loadZipBytes(input: InstallTypesInput): Promise<Buffer> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = input.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(input.url, { signal });
  } catch (error) {
    throw archiveNetworkError(error, signal, timeoutMs);
  }
  if (!response.ok)
    throw new DiagnosticError(`network: status ${response.status} for ${input.url}`, {
      stage: "archive",
      reason: "http-status",
      status: response.status,
    });
  let buffer: Buffer;
  try {
    buffer = Buffer.from(await readLimitedBody(response));
  } catch (error) {
    throw archiveNetworkError(error, signal, timeoutMs);
  }
  if (!hasZipPrefix(buffer)) {
    throw new DiagnosticError("unzip: response is not a zip archive", {
      stage: "archive",
      reason: "invalid-zip",
    });
  }
  return buffer;
}

function archiveNetworkError(
  error: unknown,
  signal: AbortSignal,
  timeoutMs: number,
): DiagnosticError {
  return new DiagnosticError(
    `network: ${error instanceof Error ? error.message : error}`,
    {
      stage: "archive",
      reason: signal.aborted ? "timeout" : "network",
      timeoutMs: signal.aborted ? timeoutMs : undefined,
    },
    { cause: error },
  );
}
