import { spawnSync } from "node:child_process";
import type { ConfigDirectory } from "../models/config.ts";
import { readWindowsDotenv } from "./scoped-dotenv-windows.ts";

export const DOTENV_NAME = /^\.env(?:\.[\w-]+)*$/;

// On POSIX a child can open a basename relative to its kernel working directory.
const readFromWorkingDirectory = String.raw`
const fs = require("node:fs");
const [name, approvedPath, approvedId, sizeLimit] = process.argv.slice(1);
const limit = Number(sizeLimit);
const stats = { bigint: true, throwIfNoEntry: false };

function read() {
  if (!/^\.env(?:\.[\w-]+)*$/.test(name) || process.cwd() !== approvedPath) return;
  const directory = fs.statSync(".", stats);
  if (!directory?.isDirectory() || approvedId !== directory.dev + ":" + directory.ino) return;
  const before = fs.lstatSync(name, stats);
  if (!before?.isFile() || before.size > limit) return;
  const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const found = fs.fstatSync(fd, { bigint: true });
    if (!found.isFile() || found.dev !== before.dev || found.ino !== before.ino || found.size > limit) return;
    const bytes = Buffer.allocUnsafe(Number(found.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) return bytes.subarray(0, offset);
      offset += count;
    }
  } finally {
    fs.closeSync(fd);
  }
}

const bytes = read();
if (bytes) process.stdout.write(bytes);
else process.exitCode = 1;
`;

export function readScopedDotenv(
  name: string,
  directory: ConfigDirectory,
  limit: number,
): Buffer | null {
  if (process.platform === "win32") return readWindowsDotenv(name, directory, limit);
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=commonjs",
      "-e",
      readFromWorkingDirectory,
      "--",
      name,
      directory.path,
      directory.id,
      String(limit),
    ],
    {
      cwd: directory.path,
      env: { ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: limit + 1,
      timeout: 5_000,
    },
  );
  return result.status === 0 && !result.error ? result.stdout : null;
}
