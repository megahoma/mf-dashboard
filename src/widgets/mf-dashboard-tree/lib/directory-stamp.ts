import fs from "node:fs";

export function directoryStamp(target: string | null): string {
  if (target == null) return "invalid";
  try {
    return `${target}\0${fs.statSync(target).isDirectory() ? "dir" : "file"}`;
  } catch {
    return `${target}\0missing`;
  }
}
