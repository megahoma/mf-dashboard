import fs from "node:fs";
import path from "node:path";
import { noLog } from "../../../shared/config/logging.ts";
import { filesFingerprint } from "../../../shared/lib/fingerprint.ts";
import type { LogContext } from "../../../shared/models/logging.ts";
import { readTree } from "./types-tree.ts";

const cache = new Map<string, { stamp: string; fingerprint: string }>();

export function treeFingerprint(dir: string, log: LogContext = noLog, fresh = false): string {
  const root = path.resolve(dir);
  const stamp = treeStamp(root);
  const hit = cache.get(root);
  if (!fresh && hit?.stamp === stamp) {
    log.event("debug", "fingerprint.types.hit", { path: root, scans: 1, reads: 0 });
    return hit.fingerprint;
  }
  const files = readTree(root);
  const fingerprint = filesFingerprint(files);
  log.event("debug", "fingerprint.types.miss", { path: root, scans: 1, reads: files.length });
  cache.set(root, { stamp, fingerprint });
  return fingerprint;
}

function treeStamp(dir: string): string {
  if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink())
    throw new Error("unzip: symlink types directory");
  const rows: string[] = [];
  const walk = (current: string, prefix: string) => {
    if (!fs.existsSync(current)) return;
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`unzip: symlink ${relative}`);
      if (stat.isDirectory()) walk(full, relative);
      else if (stat.isFile())
        rows.push(`${relative}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}\0${stat.ino}`);
    }
  };
  walk(dir, "");
  return rows.sort().join("\n");
}
