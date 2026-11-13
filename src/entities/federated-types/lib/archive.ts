import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { filesFingerprint } from "../../../shared/lib/fingerprint.ts";
import { DiagnosticError } from "../../../shared/models/diagnostic-error.ts";
import type { AdmZipFile, ZipArchive, ZipEntry } from "../models/install.ts";
import { assertTreeInside, readTree } from "./types-tree.ts";

export function checkedArchive(buffer: Buffer, appDir: string): ZipArchive {
  try {
    const archive = openArchive(buffer, appDir);
    const entries = archive.entries();
    if (!entries.some((entry) => !entry.directory)) throw new Error("unzip: archive has no files");
    for (const entry of entries) assertZipEntry(entry);
    return archive;
  } catch (error) {
    throw unzipError(error);
  }
}

export async function fingerprintArchiveBytes(bytes: Uint8Array, appDir: string): Promise<string> {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return fingerprintArchive(checkedArchive(buffer, appDir));
}

export async function fingerprintArchive(archive: ZipArchive): Promise<string> {
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

export function resolveAdmZip(appDir: string): string {
  const appRequire = createRequire(path.join(appDir, "package.json"));
  try {
    return appRequire.resolve("adm-zip");
  } catch {
    const enhanced = appRequire.resolve("@module-federation/enhanced");
    const dts = createRequire(enhanced).resolve("@module-federation/dts-plugin");
    return createRequire(dts).resolve("adm-zip");
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

export function unzipError(error: unknown): Error {
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
