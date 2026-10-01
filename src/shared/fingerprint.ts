import { createHash } from "node:crypto";

export function filesFingerprint(files: readonly { name: string; bytes: Uint8Array }[]): string {
  const ordered = [...files].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  const hash = createHash("sha256");
  for (const file of ordered) {
    hash.update(file.name);
    hash.update("\0");
    hash.update(file.bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}
