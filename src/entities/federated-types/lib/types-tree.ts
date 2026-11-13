import fs from "node:fs";
import path from "node:path";
import { pathIsInside } from "../../../shared/lib/paths.ts";

export function assertTreeInside(root: string): void {
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error("unzip: symlink types directory");
  const realRoot = fs.realpathSync(root);
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`unzip: symlink ${name}`);
      if (!pathIsInside(realRoot, fs.realpathSync(full))) {
        throw new Error(`unzip: entry escapes ${name}`);
      }
      if (stat.isDirectory()) walk(full);
    }
  };
  walk(root);
}

export function readTree(dir: string): { name: string; bytes: Uint8Array }[] {
  const files: { name: string; bytes: Uint8Array }[] = [];
  if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink())
    throw new Error("unzip: symlink types directory");
  const walk = (current: string, prefix: string) => {
    if (!fs.existsSync(current)) return;
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`unzip: symlink ${relative}`);
      if (stat.isDirectory()) walk(full, relative);
      else if (stat.isFile())
        files.push({ name: relative, bytes: new Uint8Array(fs.readFileSync(full)) });
    }
  };
  walk(dir, "");
  return files;
}
