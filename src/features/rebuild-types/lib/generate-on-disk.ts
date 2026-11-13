import type { CompilerInputs } from "../models/compiler-inputs.ts";
import type {
  GenerationRequest,
  GenerationResult,
  LocalGeneratedZip,
  LocalGenerationInput,
  LocalGenerationResult,
} from "../models/generate.ts";
import { compilerInputsFingerprint, listCompilerInputs } from "./compiler-inputs.ts";
import { readTypesZip } from "./generated-zip.ts";
import { prepareGeneration } from "./load-project.ts";

export async function generateTypesOnDisk(input: GenerationRequest): Promise<GenerationResult> {
  const { mfRequire, remote, compilerCwd, zipPath, port, generate } =
    await prepareGeneration(input);
  if (!("workspaceFingerprint" in input)) {
    return { archive: { ...(await generate()), inputsFingerprint: null, current: false }, port };
  }
  const inputs = await listCompilerInputs(mfRequire, remote, input.appDir, compilerCwd);
  const archive = await rebuildLocalArchive(input, zipPath, inputs, generate);
  return { archive, port };
}

export async function rebuildLocalArchive(
  input: LocalGenerationInput,
  zipPath: string,
  inputs: CompilerInputs | null,
  generate: () => Promise<LocalGeneratedZip>,
): Promise<LocalGenerationResult> {
  const fingerprint = inputs
    ? await compilerInputsFingerprint(input.workspaceFingerprint, inputs)
    : null;
  const { confirmed } = input;
  if (
    fingerprint &&
    confirmed?.inputsFingerprint === fingerprint &&
    confirmed.zipPath === zipPath
  ) {
    const zip = await readTypesZip(zipPath);
    if (zip && zip.zipHash === confirmed.zipHash)
      return { ...zip, inputsFingerprint: fingerprint, current: true };
  }
  const zip = await generate();
  if (
    inputs &&
    (await compilerInputsFingerprint(input.workspaceFingerprint, inputs)) !== fingerprint
  )
    throw new Error("Compiler inputs changed during type generation");
  return { ...zip, inputsFingerprint: fingerprint, current: false };
}
