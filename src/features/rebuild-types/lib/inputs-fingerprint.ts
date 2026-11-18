import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import {
  CONFIG_INPUT_LIMIT,
  CONFIG_FILE,
  configInputFingerprint,
  packageManifestInput,
  type LocalApp,
} from "../../../entities/microfrontend/index.ts";
import { configFilesFingerprint } from "../../../shared/lib/config-files-stamp.ts";
import { sha256 } from "../../../shared/lib/fingerprint.ts";
import { pathIsInside } from "../../../shared/lib/paths.ts";
import type { RebuildAllContext } from "../models/all.ts";

export function rebuildConfigFingerprint(
  app: LocalApp,
  observations?: ReadonlyMap<string, string>,
  usePlannedDirectories = false,
): string {
  const inputs = app.configInputs ?? [];
  const files = [
    ...inputs.filter((input) => !("directorySelection" in input)).map(({ file }) => file),
    ...(app.configDependencies ?? []).filter((file) => {
      const name = path.basename(file);
      return name === "package.json" || CONFIG_FILE.test(name);
    }),
  ];
  const directories = inputs.filter((input) => "directorySelection" in input);
  const selections = directories.map((input) => [
    input.file,
    usePlannedDirectories ? input.directorySelection : configInputFingerprint(input),
  ]);
  return sha256(JSON.stringify([configFilesFingerprint(files, observations), selections]));
}

export function inputsFingerprint(
  app: LocalApp,
  context: Pick<RebuildAllContext, "envMode" | "rebuildCommand">,
  customZipPath: string | null,
  tsconfigFingerprint: string,
  external: readonly [string, string, string][],
): string {
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
  if (app.bundler) hash.update(app.bundler);
  if (app.launchEnvironment) hash.update(JSON.stringify(app.launchEnvironment.env));
  hash.update(JSON.stringify(app.launchEnvironment?.allowLocalEnv ?? true));
  const inputs = app.configInputs ?? localConfigInputs(app);
  const ordered = [...inputs].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  for (const input of ordered) {
    hash.update(JSON.stringify([input, configInputFingerprint(input)]));
  }
  return hash.digest("hex");
}

function localConfigInputs(app: LocalApp) {
  const folder = realpathSync(app.folder);
  const manifest = packageManifestInput(app.folder);
  const files = new Set([app.configFile, app.buildConfigFile ?? app.configFile]);
  const configs = [...files].flatMap((file) => {
    const relative = path.relative(app.folder, file);
    if (!pathIsInside(app.folder, file)) return [];
    return [{ file, canonical: path.join(folder, relative), limit: CONFIG_INPUT_LIMIT }];
  });
  return manifest ? [...configs, manifest] : configs;
}
