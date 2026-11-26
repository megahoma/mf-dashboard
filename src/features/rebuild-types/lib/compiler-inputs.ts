import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import type { CompilerInputs, CompilerRemoteOptions } from "../models/compiler-inputs.ts";

const run = promisify(execFile);

type SdkTsConfig = {
  compilerOptions?: {
    outDir?: string;
    declarationDir?: string;
    tsBuildInfoFile?: string | null;
    outFile?: string;
    incremental?: boolean;
    composite?: boolean;
  };
};

export async function listCompilerInputs(
  mfRequire: NodeJS.Require,
  remote: CompilerRemoteOptions | undefined,
  appDir: string,
  configuredCwd: string | undefined,
): Promise<CompilerInputs | null> {
  // Extraction can add declarations to the ZIP that the compiler never reads.
  if (
    !remote ||
    (remote.compilerInstance ?? "tsc") !== "tsc" ||
    remote.implementation ||
    remote.extractRemoteTypes ||
    remote.extractThirdParty
  )
    return null;
  try {
    const { retrieveRemoteConfig, retrieveMfTypesPath, retrieveTypesAssetsInfo } = mfRequire(
      "@module-federation/dts-plugin/core",
    ) as {
      retrieveRemoteConfig(options: CompilerRemoteOptions): {
        tsConfig: SdkTsConfig;
        mapComponentsToExpose: Record<string, string>;
        remoteOptions?: CompilerRemoteOptions;
      };
      retrieveMfTypesPath(config: SdkTsConfig, options: CompilerRemoteOptions): string;
      retrieveTypesAssetsInfo(options: CompilerRemoteOptions): {
        apiTypesPath: string;
        zipTypesPath: string;
      };
    };
    const { tsConfig, mapComponentsToExpose, remoteOptions } = retrieveRemoteConfig(remote);
    const sdkRequire = createRequire(mfRequire.resolve("@module-federation/dts-plugin"));
    const { TEMP_DIR } = sdkRequire("@module-federation/sdk") as { TEMP_DIR: string };
    const cwd = path.resolve(appDir, configuredCwd ?? remote.context ?? appDir);
    const compilerPackage = createRequire(path.join(cwd, "package.json")).resolve(
      "typescript/package.json",
      { paths: [cwd, appDir] },
    );
    const { bin } = JSON.parse(await readFile(compilerPackage, "utf8")) as {
      bin?: string | { tsc?: string };
    };
    const tsc = path.resolve(
      path.dirname(compilerPackage),
      typeof bin === "string" ? bin : (bin?.tsc ?? "./bin/tsc"),
    );

    // Relative compiler options resolve from the same directory as the SDK's temporary config.
    const directory = path.join(cwd, "node_modules", TEMP_DIR);
    const file = path.join(directory, `mf-dashboard-inputs-${randomUUID()}.json`);
    const config = JSON.stringify(tsConfig);
    const readCompiler = async (option: "--listFilesOnly" | "--showConfig") => {
      await mkdir(directory, { recursive: true });
      await writeFile(file, config, { flag: "wx" });
      try {
        const { stdout } = await run(
          process.execPath,
          [tsc, option, "--pretty", "false", "--project", file],
          { cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
        );
        return stdout;
      } finally {
        await rm(file, { force: true });
      }
    };
    const files = (await readCompiler("--listFilesOnly")).split(/\r?\n/).filter(Boolean);
    if (!files.length || files.some((file) => !path.isAbsolute(file))) return null;
    return {
      config: JSON.stringify([config, mapComponentsToExpose, remote.generateAPITypes]),
      files: [compilerPackage, tsc, ...files],
      writePaths: async () => {
        if (!remoteOptions) throw new Error("SDK write paths unavailable");
        const effective = JSON.parse(await readCompiler("--showConfig")) as SdkTsConfig;
        const { outDir, declarationDir, tsBuildInfoFile, outFile, incremental, composite } =
          effective.compilerOptions ?? {};
        // An inherited outFile can emit a companion .d.ts outside the declaration tree.
        if (!outDir || outFile) throw new Error("Compiler write paths unavailable");
        const configuredBuildInfo = tsConfig.compilerOptions?.tsBuildInfoFile;
        // --showConfig can report a placeholder when TypeScript infers a build-info path.
        if (
          (incremental || composite) &&
          (!tsBuildInfoFile?.trim() || !configuredBuildInfo?.trim())
        )
          throw new Error("Compiler build-info path unavailable");
        const typesPath = retrieveMfTypesPath(tsConfig, remoteOptions);
        const { apiTypesPath, zipTypesPath } = retrieveTypesAssetsInfo(remote);
        const sdkPaths = remoteOptions.generateAPITypes
          ? [zipTypesPath, apiTypesPath]
          : [zipTypesPath];
        if (![typesPath, ...sdkPaths].every(path.isAbsolute))
          throw new Error("SDK write paths unavailable");
        const entries = Object.keys(mapComponentsToExpose).map((expose) =>
          path.join(typesPath, `${expose === "." ? "index" : expose}.d.ts`),
        );
        const paths = [cwd, directory, ...sdkPaths, ...entries];
        if (tsBuildInfoFile) paths.push(path.resolve(directory, tsBuildInfoFile));
        // SDK cleanup also uses the original value relative to its context or process CWD.
        if (configuredBuildInfo) {
          paths.push(path.resolve(remoteOptions.context ?? appDir, configuredBuildInfo));
          paths.push(path.resolve(appDir, configuredBuildInfo));
        }
        const declarationTrees = [typesPath, path.resolve(directory, outDir)];
        if (declarationDir) declarationTrees.push(path.resolve(directory, declarationDir));
        return { paths, declarationTrees };
      },
    };
  } catch {
    // The generator can still run when its compiler cannot supply complete evidence.
    return null;
  }
}

export async function compilerInputsFingerprint(
  workspaceFingerprint: string,
  inputs: CompilerInputs,
): Promise<string> {
  const hash = createHash("sha256").update(JSON.stringify([workspaceFingerprint, inputs.config]));
  for (const file of inputs.files) {
    const content = createHash("sha256")
      .update(await readFile(file))
      .digest();
    hash.update(JSON.stringify(file)).update(content);
  }
  return hash.digest("hex");
}
