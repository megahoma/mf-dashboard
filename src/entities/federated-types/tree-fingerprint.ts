import fs from "node:fs";
import path from "node:path";
import { filesFingerprint } from "../../shared/fingerprint.ts";
import { readTree } from "./install.ts";

const cache = new Map<string, { stamp: string; fingerprint: string }>();

export function treeFingerprint(dir: string): string {
  const root = path.resolve(dir);
  const stamp = treeStamp(root);
  const hit = cache.get(root);
  if (hit?.stamp === stamp) return hit.fingerprint;
  const fingerprint = filesFingerprint(readTree(root));
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
      else if (stat.isFile()) rows.push(`${relative}\0${stat.size}\0${stat.mtimeMs}`);
    }
  };
  walk(dir, "");
  return rows.sort().join("\n");
}
