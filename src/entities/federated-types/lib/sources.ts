import fs from "node:fs";
import path from "node:path";
import { noLog } from "../../../shared/config/logging.ts";
import { filesFingerprint } from "../../../shared/lib/fingerprint.ts";
import type { LogContext } from "../../../shared/models/logging.ts";
import type { SourceEntry, SourceFile, SourceIdentity, SourceSnapshot } from "../models/sources.ts";
import { sourceEntries } from "./source-entries.ts";

const sourceCache = new Map<string, { stamp: string; identity: SourceIdentity }>();

// Same-size edits that preserve mtime reuse the fingerprint, matching the freshness clock.
export function sourceIdentity(
  folder: string,
  tsconfig: string | null,
  typesFolder: string,
  log: LogContext = noLog,
): SourceIdentity {
  let tsconfigFingerprint = "";
  const entries = sourceEntries(folder, tsconfig, typesFolder, (config) => {
    tsconfigFingerprint = filesFingerprint([
      { name: "tsconfig", bytes: Buffer.from(JSON.stringify(config)) },
    ]);
  });
  const stamp = entries
    .map((entry) => `${entry.name}\0${entry.size}\0${entry.savedAt}`)
    .sort()
    .join("\n");
  const key = `${path.resolve(folder)}\0${tsconfig ?? ""}\0${typesFolder}`;
  const hit = sourceCache.get(key);
  if (hit?.stamp === stamp) {
    log.event("debug", "fingerprint.sources.hit", {
      folder,
      scans: 1,
      reads: 0,
      files: entries.length,
    });
    return { ...hit.identity, names: [...hit.identity.names], tsconfigFingerprint };
  }
  log.event("debug", "fingerprint.sources.miss", {
    folder,
    scans: 1,
    reads: entries.length,
    files: entries.length,
  });
  const identity: SourceIdentity = {
    savedAt: latestSave(entries),
    fingerprint: filesFingerprint(entries.map(readSourceFile)),
    names: entries.map((entry) => entry.name).sort(),
    tsconfigFingerprint,
  };
  sourceCache.set(key, { stamp, identity });
  return { ...identity, names: [...identity.names] };
}

// Own .ts/.tsx from the producer's tsconfig. Downloaded types and emit directories are not sources.
export function sourceSnapshot(
  folder: string,
  tsconfig: string | null,
  typesFolder: string,
): SourceSnapshot {
  const entries = sourceEntries(folder, tsconfig, typesFolder);
  return {
    savedAt: latestSave(entries),
    files: entries.map(readSourceFile),
  };
}

export function sourceContains(
  folder: string,
  tsconfig: string | null,
  typesFolder: string,
  file: string,
): boolean {
  const full = path.resolve(file);
  return sourceEntries(folder, tsconfig, typesFolder).some((entry) => entry.fullPath === full);
}

function latestSave(entries: readonly SourceEntry[]): number | null {
  return entries.reduce<number | null>(
    (latest, entry) => (latest == null || entry.savedAt > latest ? entry.savedAt : latest),
    null,
  );
}

function readSourceFile(entry: SourceEntry): SourceFile {
  return { name: entry.name, bytes: new Uint8Array(fs.readFileSync(entry.fullPath)) };
}
