import fs from "node:fs";
import path from "node:path";
import { sha256 } from "../../../shared/lib/fingerprint.ts";
import { canonicalPathIsInside } from "../../../shared/lib/paths.ts";
import type { ConfigDirectory, ConfigInput } from "../models/config.ts";
import { DOTENV_NAME, readScopedDotenv } from "./scoped-dotenv.ts";

export const CONFIG_INPUT_LIMIT = 1024 * 1024;

type ReadOptions = {
  onError?: (error: unknown) => void;
  reserveBytes?: (size: number) => void;
  inputs?: Map<string, ConfigInput>;
  expectedPath?: string;
  expectedDirectory?: ConfigDirectory;
  lookup?: string;
};

export function canonicalDirectoryPath(folder: string): string {
  return fs.realpathSync.native(folder);
}

export function readConfigDirectory(folder: string): ConfigDirectory | undefined {
  try {
    const canonical = canonicalDirectoryPath(folder);
    const stat = fs.lstatSync(canonical, { bigint: true });
    if (stat.isDirectory() && canonicalDirectoryPath(canonical) === canonical)
      return { path: canonical, id: `${stat.dev}:${stat.ino}` };
  } catch {
    // The directory can disappear during discovery.
  }
}

function matchesConfigDirectory(directory: ConfigDirectory): boolean {
  const stat = fs.lstatSync(directory.path, { bigint: true });
  return (
    stat.isDirectory() &&
    `${stat.dev}:${stat.ino}` === directory.id &&
    (directory.packageMarkers?.every(
      ([file, present]) => Boolean(fs.lstatSync(file, { throwIfNoEntry: false })) === present,
    ) ??
      true) &&
    (directory.related?.every(matchesConfigDirectory) ?? true)
  );
}

export function readConfigInput(file: string, limit: number, options?: ReadOptions): string | null {
  return readBytes(file, limit, options)?.toString("utf8") ?? null;
}

export function packageManifestInput(
  folder: string,
  directory = readConfigDirectory(folder),
): ConfigInput | undefined {
  if (directory) {
    return {
      file: path.join(folder, "package.json"),
      packageDirectory: { path: directory.path, id: directory.id },
    };
  }
}

export function configInputFingerprint(input: ConfigInput): string | null {
  if ("directorySelection" in input)
    return configDirectoryIdentity(readConfigDirectory(input.file));
  if ("packageBoundary" in input) return fs.existsSync(input.file) ? "present" : null;
  try {
    if ("packageDirectory" in input)
      return fingerprintPackageManifest(input.file, input.packageDirectory);
    if ("resolutionRoot" in input) {
      const real = fs.realpathSync.native(input.file);
      return canonicalPathIsInside(input.resolutionRoot, real) &&
        !real.split(path.sep).includes("node_modules") &&
        fs.statSync(real).isFile()
        ? "resolved"
        : null;
    }
    const { canonical, limit, directory } = input;
    const real = directory
      ? path.join(canonicalDirectoryPath(path.dirname(input.file)), path.basename(input.file))
      : fs.realpathSync(input.file);
    if (real !== canonical && (directory || fs.realpathSync.native(input.file) !== canonical))
      return null;
    if (directory && !matchesConfigDirectory(directory)) return null;
    const stat = fs.lstatSync(canonical);
    if (stat.isFile() && stat.size > limit)
      return `metadata:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const bytes = readBytes(canonical, limit, {
      expectedPath: canonical,
      expectedDirectory: directory,
    });
    return bytes && sha256(bytes);
  } catch {
    return null;
  }
}

export function configDirectoryIdentity(directory: ConfigDirectory | undefined): string | null {
  return directory ? JSON.stringify([directory.path, directory.id]) : null;
}

function fingerprintPackageManifest(file: string, root: ConfigDirectory): string | null {
  if (canonicalDirectoryPath(path.dirname(file)) !== root.path || !matchesConfigDirectory(root))
    return null;
  const target = fs.realpathSync.native(file);
  if (!canonicalPathIsInside(root.path, target)) return null;
  const parent = readConfigDirectory(path.dirname(target));
  if (!parent || !canonicalPathIsInside(root.path, parent.path)) return null;
  const digest = configInputFingerprint({
    file: target,
    canonical: target,
    directory: parent.path === root.path ? root : { ...parent, related: [root] },
    limit: CONFIG_INPUT_LIMIT,
  });
  if (digest === null || fs.realpathSync.native(file) !== target) return null;
  return sha256(JSON.stringify([target, digest]));
}

function readBytes(file: string, limit: number, options?: ReadOptions): Buffer | null {
  try {
    const expectedDirectory = options?.expectedDirectory;
    const parent = expectedDirectory
      ? canonicalDirectoryPath(path.dirname(file))
      : options?.inputs || options?.expectedPath
        ? fs.realpathSync(path.dirname(file))
        : undefined;
    const canonical = parent === undefined ? undefined : path.join(parent, path.basename(file));
    if (options?.expectedPath && canonical !== options.expectedPath) return null;
    if (
      expectedDirectory &&
      (parent !== expectedDirectory.path || !matchesConfigDirectory(expectedDirectory))
    )
      return null;
    if (canonical && options?.inputs) {
      // A rejected or missing candidate can become a readable file during generation.
      const lookup = options?.lookup ?? file;
      options.inputs.set(lookup, {
        file: lookup,
        canonical,
        limit,
        ...(expectedDirectory && { directory: expectedDirectory }),
      });
    }
    const before = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!before?.isFile()) return null;
    const name = path.basename(file);
    if (expectedDirectory && DOTENV_NAME.test(name)) {
      if (before.size > limit) return null;
      const bytes = readScopedDotenv(name, expectedDirectory, limit);
      return bytes && matchesConfigDirectory(expectedDirectory) ? bytes : null;
    }
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > limit) return null;
      if (canonical) {
        const current = fs.lstatSync(canonical);
        if (
          fs.realpathSync(canonical) !== canonical ||
          !current.isFile() ||
          before.dev !== stat.dev ||
          before.ino !== stat.ino ||
          current.dev !== stat.dev ||
          current.ino !== stat.ino
        )
          return null;
      }
      if (expectedDirectory && !matchesConfigDirectory(expectedDirectory)) return null;
      const capacity = stat.size + 1;
      options?.reserveBytes?.(capacity);
      const bytes = Buffer.allocUnsafe(capacity);
      let size = 0;
      while (size < bytes.length) {
        const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
        if (!count) return bytes.subarray(0, size);
        size += count;
      }
      return null;
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    options?.onError?.(error);
    return null;
  }
}
