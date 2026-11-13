import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { LocalApp } from "../../../entities/microfrontend/index.ts";
import { DEFAULT_TSCONFIG } from "../../../shared/config/project.ts";
import { modeEnvFiles } from "../../../shared/lib/env-files.ts";
import { sha256 } from "../../../shared/lib/fingerprint.ts";
import type { RebuildAllContext } from "../models/all.ts";

export async function inputsFingerprint(
  app: LocalApp,
  context: RebuildAllContext,
  customZipPath: string | null,
  tsconfigFingerprint: string,
  external: readonly [string, string, string][],
): Promise<string> {
  const hash = createHash("sha256");
  const envMode = app.launchEnvironment?.envMode ?? context.envMode;
  hash.update(
    JSON.stringify([
      app.folder,
      app.name,
      app.remotes,
      app.tsconfig,
      app.compilerInstance,
      app.typesFolder,
      envMode,
      context.rebuildCommand,
      customZipPath,
      tsconfigFingerprint,
      external,
    ]),
  );
  if (app.launchEnvironment) hash.update(JSON.stringify(app.launchEnvironment.env));
  const names = ["package.json", app.tsconfig?.trim() || DEFAULT_TSCONFIG, ".env", ".env.local"];
  if (/^[\w-]+(?:\.[\w-]+)*$/.test(envMode)) names.push(...modeEnvFiles(envMode));
  const files = new Set([
    app.configFile,
    app.buildConfigFile ?? app.configFile,
    ...(app.configDependencies ?? []),
    ...names.map((name) => path.resolve(app.folder, name)),
  ]);
  for (const file of [...files].sort()) {
    let fingerprint: string | null = null;
    try {
      if ((await stat(file)).isFile()) fingerprint = sha256(await readFile(file));
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      ))
        throw error;
    }
    hash.update(JSON.stringify([file, fingerprint]));
  }
  return hash.digest("hex");
}
