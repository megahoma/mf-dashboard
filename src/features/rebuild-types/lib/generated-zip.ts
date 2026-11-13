import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fingerprintArchiveAsync } from "../../../entities/federated-types/lib/evidence-worker-client.mts";
import { sha256 } from "../../../shared/lib/fingerprint.ts";
import { hasZipPrefix } from "../../../shared/lib/zip.ts";
import type { LocalGeneratedZip } from "../models/generate.ts";

export function zipRevision(zipPath: string): string | null {
  const stat = statSync(zipPath, { bigint: true, throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile()) throw new Error(`types ZIP path is not a file: ${zipPath}`);
  return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

export async function readTypesZip(
  zipPath: string,
  verifyIn?: string,
): Promise<LocalGeneratedZip | null> {
  if (zipRevision(zipPath) == null) return null;
  const bytes = await readFile(zipPath);
  if (!hasZipPrefix(bytes)) return null;
  if (verifyIn) await fingerprintArchiveAsync(bytes, verifyIn);
  return { zipPath, zipHash: sha256(bytes) };
}

export async function generatedZip(
  zipPath: string,
  before: string | null,
  appDir: string,
): Promise<LocalGeneratedZip> {
  if (before !== null && before === zipRevision(zipPath))
    throw new Error(`generation did not write the types ZIP: ${zipPath}`);
  const zip = await readTypesZip(zipPath, appDir);
  if (!zip) throw new Error(`generated types ZIP is missing or invalid: ${zipPath}`);
  return zip;
}
