import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

export interface CompilerRemoteOptions {
  context?: string;
  compilerInstance?: string;
  implementation?: string;
  generateAPITypes?: boolean;
  extractRemoteTypes?: boolean;
  extractThirdParty?: boolean | object;
}

export interface CompilerInputs {
  config: string;
  files: readonly string[];
}

const run = promisify(execFile);

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
    const { retrieveRemoteConfig } = mfRequire("@module-federation/dts-plugin/core") as {
      retrieveRemoteConfig(options: CompilerRemoteOptions): {
        tsConfig: object;
        mapComponentsToExpose: Record<string, string>;
      };
    };
    const { tsConfig, mapComponentsToExpose } = retrieveRemoteConfig(remote);
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
    await mkdir(directory, { recursive: true });
    await writeFile(file, config, { flag: "wx" });
    try {
      const { stdout } = await run(
        process.execPath,
        [tsc, "--listFilesOnly", "--pretty", "false", "--project", file],
        { cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
      );
      const files = stdout.split(/\r?\n/).filter(Boolean);
      if (!files.length || files.some((file) => !path.isAbsolute(file))) return null;
      return {
        config: JSON.stringify([config, mapComponentsToExpose, remote.generateAPITypes]),
        files: [compilerPackage, tsc, ...files],
      };
    } finally {
      await rm(file, { force: true });
    }
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
