import fs from "node:fs";

export function readConfigInput(file: string, limit: number): string | null {
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > limit) return null;
      const bytes = Buffer.allocUnsafe(stat.size + 1);
      let size = 0;
      while (size < bytes.length) {
        const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
        if (!count) return bytes.toString("utf8", 0, size);
        size += count;
      }
      return null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}
