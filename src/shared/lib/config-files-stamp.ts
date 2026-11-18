import fs from "node:fs";
import { sha256 } from "./fingerprint.ts";

export function configFilesFingerprint(
  files: readonly string[],
  observations?: ReadonlyMap<string, string>,
): string {
  return sha256(configFilesStamp(files, observations));
}

export function configFilesStamp(
  files: readonly string[],
  observations?: ReadonlyMap<string, string>,
): string {
  return [...new Set(files)]
    .sort()
    .map((file) => observations?.get(file) ?? configFileStamp(file))
    .join("\n");
}

export function configFileStamp(file: string): string {
  try {
    return stampRow(file, fs.statSync(file), fs.realpathSync(file));
  } catch {
    try {
      const entry = fs.lstatSync(file, { throwIfNoEntry: false });
      if (entry?.isSymbolicLink()) return stampRow(file, entry, "unresolved-link");
    } catch {
      // The entry may become inaccessible while collecting the stamp.
    }
    return `${file}\0missing`;
  }
}

function stampRow(file: string, stat: fs.Stats, real: string): string {
  return `${file}\0${real}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}\0${stat.ino}\0${stat.mode}`;
}
