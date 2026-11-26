import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { deserialize, serialize } from "node:v8";
import crc32 from "buffer-crc32";
import { Entry, fromBufferPromise } from "yauzl";
import { sha256 } from "../../../shared/lib/fingerprint.ts";
import type { ComparisonArchive } from "../models/install.ts";
import { checkedZipEntryName, unzipError } from "./archive.ts";
import type { readTree } from "./types-tree.ts";

const MAX_ENTRIES = 20_000;
const MAX_ENTRY_NAME = 4_096;
const MAX_EXTRA_FIELDS = 200_000;
const MAX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
const DATA_DESCRIPTOR_FLAG = 0x08;
const INVALID_WINDOWS_PATH = /[:*?"<>|]|[. ](?:\/|$)/;

type ArchiveIndex = { entries: Map<string, string>; directories: string[] };

export async function indexComparisonArchive(bytes: Uint8Array): Promise<ComparisonArchive> {
  try {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const archive = await fromBufferPromise(buffer, {
      decodeStrings: false,
      validateEntrySizes: true,
    });
    try {
      if (archive.entryCount > MAX_ENTRIES) throw new Error("too many ZIP entries");
      const files = new Map<string, Entry>();
      const directories: string[] = [];
      const seen = new Set<string>();
      const records: { start: number; end: number }[] = [];
      let remainingExpanded = MAX_UNCOMPRESSED_BYTES;
      let remainingCompressed = buffer.length;
      let remainingExtraFields = MAX_EXTRA_FIELDS;
      for await (const entry of archive.eachEntry()) {
        remainingExtraFields -= entry.extraFields.length;
        if (remainingExtraFields < 0) throw new Error("ZIP exceeds extra field limit");
        if (entry.fileNameRaw.length > MAX_ENTRY_NAME) throw new Error("invalid ZIP entry name");
        // Install uses the UTF-8 central filename, including when an extra field offers an alias.
        const filename = checkedZipEntryName(entry.fileNameRaw.toString("utf8"));
        const directory = filename.endsWith("/");
        if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000)
          throw new Error(`symlink ${filename}`);
        remainingCompressed -= entry.compressedSize;
        if (remainingCompressed < 0) throw new Error("ZIP exceeds compressed size limit");
        const { fileDataStart } = await archive.readLocalFileHeaderPromise(entry, {
          minimal: true,
        });
        const start = entry.relativeOffsetOfLocalHeader;
        records.push({
          start,
          end: fileDataStart + entry.compressedSize,
        });
        const name = path.posix.normalize(filename).replace(/\/$/, "");
        if (name === "." && directory) continue;
        if (!name || name === "." || seen.has(name))
          throw new Error("invalid or duplicate ZIP entry");
        seen.add(name);
        if (directory) {
          if (entry.uncompressedSize !== 0) throw new Error("ZIP directory has content");
          directories.push(name);
          continue;
        }
        // A local header may contain a placeholder CRC when a data descriptor is in use.
        const localFlags = buffer.readUInt16LE(start + 6);
        if (
          !((localFlags | entry.generalPurposeBitFlag) & DATA_DESCRIPTOR_FLAG) &&
          buffer.readUInt32LE(start + 14) !== entry.crc32
        )
          throw new Error(`inconsistent ZIP CRC for ${name}`);
        remainingExpanded -= entry.uncompressedSize;
        if (remainingExpanded < 0) throw new Error("ZIP exceeds expanded size limit");
        // Retain only the fields the decoder needs to open the stream in the second pass.
        files.set(
          name,
          Object.assign(new Entry(), {
            relativeOffsetOfLocalHeader: start,
            generalPurposeBitFlag: entry.generalPurposeBitFlag,
            compressionMethod: entry.compressionMethod,
            compressedSize: entry.compressedSize,
            uncompressedSize: entry.uncompressedSize,
            crc32: entry.crc32,
          }),
        );
      }
      if (!files.size) throw new Error("archive has no files");
      records.sort((a, b) => a.start - b.start);
      for (let index = 1; index < records.length; index++) {
        if (records[index].start < records[index - 1].end)
          throw new Error("overlapping ZIP records");
      }
      // With a trailing slash, a parent and its descendants sort together.
      const paths = [...seen].map((name) => `${name}/`).sort();
      for (let index = 0; index + 1 < paths.length; index++) {
        const prefix = paths[index];
        if (paths[index + 1].startsWith(prefix) && files.has(prefix.slice(0, -1)))
          throw new Error("ZIP file conflicts with a directory");
      }
      const entries = new Map<string, string>();
      for (const [name, entry] of files) {
        const digest = createHash("sha256");
        let crc = 0;
        for await (const chunk of await archive.openReadStreamPromise(entry)) {
          crc = crc32.unsigned(chunk, crc);
          digest.update(chunk);
        }
        if (crc !== entry.crc32) throw new Error(`invalid CRC for ${name}`);
        entries.set(name, digest.digest("hex"));
      }
      const index: ArchiveIndex = { entries, directories: directories.sort() };
      const encoded = serialize(index);
      // Keep the index shared so every consumer can compare against it without copying ZIP names.
      const entryIndex = new Uint8Array(new SharedArrayBuffer(encoded.length));
      entryIndex.set(encoded);
      const contentHash = sha256(JSON.stringify([...entries].sort(([a], [b]) => (a < b ? -1 : 1))));
      return { fileCount: entries.size, contentHash, entryIndex };
    } finally {
      archive.close();
    }
  } catch (error) {
    throw unzipError(error);
  }
}

export function matchesArchiveFiles(
  destination: string,
  files: ReturnType<typeof readTree>,
  archive: ComparisonArchive,
): boolean {
  if (files.length !== archive.fileCount) return false;

  const remaining = new Map(files.map(({ name, bytes }) => [name, bytes]));
  const directories = new Map<string, InstalledDirectory>();
  let root: string | undefined;
  const index = deserialize(archive.entryIndex) as ArchiveIndex;
  const { entries } = index;
  for (const [name, digest] of entries) {
    let installed = name;
    if (!remaining.has(name)) {
      if (process.platform === "win32" && INVALID_WINDOWS_PATH.test(name)) return false;
      try {
        root ??= fs.realpathSync.native(destination);
        const canonical = fs.realpathSync.native(path.join(root, name));
        installed = path.relative(root, canonical).split(path.sep).join("/");
        // Some filesystems resolve names case-insensitively without canonicalizing their spelling.
        if (!remaining.has(installed) && installed === name)
          installed = spelledPath(root, name, directories);
        if (!remaining.has(installed) || !isFilesystemAlias(root, name, installed)) return false;
      } catch {
        return false;
      }
    }
    const bytes = remaining.get(installed);
    if (!bytes || sha256(bytes) !== digest) return false;
    remaining.delete(installed);
  }
  return directoriesFit(destination, index.directories);
}

function directoriesFit(destination: string, names: readonly string[]): boolean {
  let previous: string[] = [];
  let existingDepth = 0;
  try {
    for (const name of names) {
      if (process.platform === "win32" && INVALID_WINDOWS_PATH.test(name)) return false;
      const parts = name.split("/");
      let shared = 0;
      while (shared < parts.length && parts[shared] === previous[shared]) shared++;
      previous = parts;
      // Sorted names let siblings reuse checked ancestors, including a missing directory.
      if (shared > existingDepth) continue;
      existingDepth = shared;
      let folder = path.join(destination, ...parts.slice(0, shared));
      for (const part of parts.slice(shared)) {
        folder = path.join(folder, part);
        const entry = fs.lstatSync(folder, { throwIfNoEntry: false });
        if (!entry) break;
        if (!entry.isDirectory()) return false;
        existingDepth++;
      }
    }
    return true;
  } catch {
    return false;
  }
}

type InstalledDirectory = {
  names: Set<string>;
  byId?: Map<string, string | null>;
};

function spelledPath(root: string, name: string, directories: Map<string, InstalledDirectory>) {
  const parts: string[] = [];
  for (const part of name.split("/")) {
    let directory = directories.get(root);
    if (!directory) {
      directory = { names: new Set(fs.readdirSync(root)) };
      directories.set(root, directory);
    }
    let actual = part;
    if (!directory.names.has(part)) {
      const id = fileId(path.join(root, part));
      if (!id) return "";
      if (!directory.byId) {
        directory.byId = new Map();
        for (const entry of directory.names) {
          const key = fileId(path.join(root, entry));
          if (key) directory.byId.set(key, directory.byId.has(key) ? null : entry);
        }
      }
      const spelling = directory.byId.get(id);
      if (!spelling) return "";
      actual = spelling;
    }
    parts.push(actual);
    root = path.join(root, actual);
  }
  return parts.join("/");
}

function fileId(file: string): string | null {
  const stat = fs.lstatSync(file, { bigint: true });
  return stat.ino !== 0n && (stat.isFile() || stat.isDirectory())
    ? `${stat.dev}:${stat.ino}`
    : null;
}

function isFilesystemAlias(root: string, requested: string, installed: string): boolean {
  const parts = installed.split("/");
  const aliases = requested.split("/");
  if (parts.length !== aliases.length) return false;
  for (const [index, part] of parts.entries()) {
    const actual = path.join(root, part);
    const alias = aliases[index];
    if (alias !== part) {
      const id = fileId(actual);
      if (!id || fileId(path.join(root, alias)) !== id) return false;
    }
    root = actual;
  }
  return true;
}
