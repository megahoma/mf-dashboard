import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import { mkdtemp, mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { filesFingerprint } from "../../shared/fingerprint.ts";
import { readLimitedBody } from "../../shared/http-body.ts";
import { createKeyedLock } from "../../shared/queue.ts";
import { DiagnosticError } from "../../shared/diagnostic-error.ts";

const destinationLock = createKeyedLock();

const DEFAULT_TIMEOUT_MS = 60_000;

interface ZipEntry {
  name: string;
  directory: boolean;
  symlink: boolean;
}

interface ZipArchive {
  entries(): ZipEntry[];
  extractTo(dir: string): void;
}

interface AdmZipEntry {
  entryName: string;
  isDirectory: boolean;
  header?: { attr?: number };
}

interface AdmZipFile {
  getEntries(): AdmZipEntry[];
  extractAllTo(dir: string, overwrite: boolean): void;
}

export interface InstallTypesInput {
  url: string;
  destination: string;
  appDir: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface InstallTypesResult {
  zipHash: string;
  filesFingerprint: string;
}

// Download, check, then swap. The live types directory is not removed before the archive checks out.
export function installTypesArchive(input: InstallTypesInput): Promise<InstallTypesResult> {
  return destinationLock(path.resolve(input.destination), () => writeTypesArchive(input));
}

async function writeTypesArchive(input: InstallTypesInput): Promise<InstallTypesResult> {
  const loaded = await loadZip(input);
  const destination = path.resolve(input.destination);
  await mkdir(path.dirname(destination), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(destination), ".install-"));
  const backup = `${destination}.backup-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let parked = false;
  try {
    loaded.archive.extractTo(staging);
    assertTreeInside(staging);
    if (fs.existsSync(destination)) {
      await rename(destination, backup);
      parked = true;
    }
    await rename(staging, destination);
    if (parked) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (parked && !fs.existsSync(destination) && fs.existsSync(backup))
      await rename(backup, destination);
    throw unzipError(error);
  }
  return { zipHash: loaded.zipHash, filesFingerprint: filesFingerprint(readTree(destination)) };
}

// A custom command is not trusted: compare the directory to the zip and do not delete it on failure.
export function confirmInstalledArchive(input: InstallTypesInput): Promise<InstallTypesResult> {
  return destinationLock(path.resolve(input.destination), () => checkInstalledArchive(input));
}

async function checkInstalledArchive(input: InstallTypesInput): Promise<InstallTypesResult> {
  const loaded = await loadZip(input);
  const destination = path.resolve(input.destination);
  if (!fs.existsSync(destination) || !fs.statSync(destination).isDirectory()) {
    throw new DiagnosticError("unzip: types directory is missing", {
      stage: "destination",
      reason: "directory-missing",
    });
  }
  assertTreeInside(destination);
  const files = readTree(destination);
  if (files.length === 0)
    throw new DiagnosticError("unzip: types directory is empty", {
      stage: "destination",
      reason: "directory-empty",
    });
  const fingerprint = filesFingerprint(files);
  const extracted = await fingerprintArchive(loaded.archive);
  if (fingerprint !== extracted)
    throw new DiagnosticError("unzip: installed files do not match the archive", {
      stage: "destination",
      reason: "fingerprint-mismatch",
    });
  return { zipHash: loaded.zipHash, filesFingerprint: fingerprint };
}

async function loadZip(
  input: InstallTypesInput,
): Promise<{ archive: ZipArchive; zipHash: string }> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = input.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(input.url, { signal });
  } catch (error) {
    throw new DiagnosticError(
      `network: ${error instanceof Error ? error.message : error}`,
      {
        stage: "archive",
        reason: signal.aborted ? "timeout" : "network",
        timeoutMs: signal.aborted ? timeoutMs : undefined,
      },
      { cause: error },
    );
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
    throw new DiagnosticError(
      `network: ${error instanceof Error ? error.message : error}`,
      {
        stage: "archive",
        reason: signal.aborted ? "timeout" : "network",
        timeoutMs: signal.aborted ? timeoutMs : undefined,
      },
      { cause: error },
    );
  }
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new DiagnosticError("unzip: response is not a zip archive", {
      stage: "archive",
      reason: "invalid-zip",
    });
  }
  let archive: ZipArchive;
  try {
    archive = openArchive(buffer, input.appDir);
    const entries = archive.entries();
    if (!entries.some((entry) => !entry.directory)) throw new Error("unzip: archive has no files");
    for (const entry of entries) assertZipEntry(entry);
  } catch (error) {
    throw unzipError(error);
  }
  return { archive, zipHash: sha256(buffer) };
}

async function fingerprintArchive(archive: ZipArchive): Promise<string> {
  const staging = await mkdtemp(path.join(tmpdir(), "mf-install-check-"));
  try {
    archive.extractTo(staging);
    assertTreeInside(staging);
    return filesFingerprint(readTree(staging));
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

function openArchive(buffer: Buffer, appDir: string): ZipArchive {
  const AdmZip = loadAdmZip(appDir);
  const zip = new AdmZip(buffer);
  return {
    entries() {
      return zip.getEntries().map((entry) => ({
        name: entry.entryName,
        directory: entry.isDirectory,
        symlink: isSymlink(entry.header?.attr ?? 0),
      }));
    },
    extractTo(dir: string) {
      zip.extractAllTo(dir, true);
    },
  };
}

function loadAdmZip(appDir: string): new (source: Buffer) => AdmZipFile {
  const appRequire = createRequire(path.join(appDir, "package.json"));
  try {
    return appRequire("adm-zip") as new (source: Buffer) => AdmZipFile;
  } catch {
    // adm-zip@0.6.0 is nested under dts-plugin, the same package the proved install used.
    const enhanced = appRequire.resolve("@module-federation/enhanced");
    const dts = createRequire(enhanced).resolve("@module-federation/dts-plugin");
    return createRequire(dts)("adm-zip") as new (source: Buffer) => AdmZipFile;
  }
}

function assertZipEntry(entry: ZipEntry): void {
  const name = entry.name.replaceAll("\\", "/");
  if (name === "" || name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new Error(`unzip: absolute entry ${entry.name}`);
  }
  if (name.split("/").includes("..")) throw new Error(`unzip: traversal ${entry.name}`);
  if (entry.symlink) throw new Error(`unzip: symlink ${entry.name}`);
}

function isSymlink(attr: number): boolean {
  const mode = (attr >>> 16) & 0xffff;
  return (mode & 0o170000) === 0o120000;
}

function assertTreeInside(root: string): void {
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error("unzip: symlink types directory");
  const realRoot = fs.realpathSync(root);
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`unzip: symlink ${name}`);
      const rel = path.relative(realRoot, fs.realpathSync(full));
      if (rel.startsWith(`..${path.sep}`) || rel === ".." || path.isAbsolute(rel)) {
        throw new Error(`unzip: entry escapes ${name}`);
      }
      if (stat.isDirectory()) walk(full);
    }
  };
  walk(root);
}

export function readTree(dir: string): { name: string; bytes: Uint8Array }[] {
  const files: { name: string; bytes: Uint8Array }[] = [];
  if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink())
    throw new Error("unzip: symlink types directory");
  const walk = (current: string, prefix: string) => {
    if (!fs.existsSync(current)) return;
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`unzip: symlink ${relative}`);
      if (stat.isDirectory()) walk(full, relative);
      else if (stat.isFile())
        files.push({ name: relative, bytes: new Uint8Array(fs.readFileSync(full)) });
    }
  };
  walk(dir, "");
  return files;
}

function unzipError(error: unknown): Error {
  if (error instanceof DiagnosticError) return error;
  if (error instanceof Error && error.message.startsWith("unzip:"))
    return new DiagnosticError(
      error.message,
      { stage: "archive", reason: "archive-invalid" },
      { cause: error },
    );
  return new DiagnosticError(`unzip: ${error instanceof Error ? error.message : error}`, {
    stage: "archive",
    reason: "archive-invalid",
  });
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
