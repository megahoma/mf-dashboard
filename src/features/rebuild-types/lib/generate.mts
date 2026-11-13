import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashManifestZip } from "../../../entities/microfrontend/index.ts";
import { createSerialQueue } from "../../../shared/lib/queue.ts";
import { stopProcessTree } from "../../../shared/lib/shell.ts";
import { localManifestUrl } from "../../../shared/lib/urls.ts";
import { DiagnosticError } from "../../../shared/models/diagnostic-error.ts";
import { REBUILD_TIMEOUT_MS } from "../config/command.ts";
import { REBUILD_HINT } from "../config/generate.ts";
import type {
  GeneratedZip,
  GenerationInput,
  GenerationReply,
  GenerationRequest,
  GenerationResult,
  LocalGenerationInput,
  LocalGenerationResult,
} from "../models/generate.ts";

const oneGeneration = createSerialQueue();

export function generateLocalFederatedTypes(
  input: LocalGenerationInput,
  timeoutMs = REBUILD_TIMEOUT_MS,
): Promise<LocalGenerationResult> {
  return oneGeneration(async () => (await runGenerationProcess(input, timeoutMs)).archive);
}

function runGenerationProcess(
  input: GenerationRequest,
  timeoutMs: number,
): Promise<GenerationResult> {
  return new Promise((resolve, reject) => {
    const bundled = typeof __dirname === "string";
    const entry = bundled
      ? path.join(__dirname, "generate-process.js")
      : fileURLToPath(new URL("../generate-process.ts", import.meta.url));
    // The SDK and project config use process.cwd() and process.env during generation.
    const child = fork(entry, [], {
      cwd: input.appDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      execArgv: bundled ? [] : undefined,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      detached: process.platform !== "win32",
    });
    let reply: GenerationReply | undefined;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void stopProcessTree(child.pid).then(
        () =>
          reject(
            new DiagnosticError(`Type generation timed out after ${timeoutMs} ms`, {
              stage: "generation",
              reason: "timeout",
              timeoutMs,
            }),
          ),
        (cause: unknown) =>
          reject(new Error("Could not stop timed-out type generator process tree", { cause })),
      );
    }, timeoutMs);
    child.once("message", (message) => {
      reply = message as GenerationReply;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (!timedOut) reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (reply && "error" in reply) {
        reject(
          reply.details ? new DiagnosticError(reply.error, reply.details) : new Error(reply.error),
        );
      } else if (code === 0 && reply) resolve(reply.result);
      else reject(new Error(`Type generator exited (${signal ?? code})`));
    });
    child.send(input, (error) => {
      if (error && !timedOut) {
        clearTimeout(timer);
        child.kill();
        reject(error);
      }
    });
  });
}

export function generateFederatedTypes(
  input: GenerationInput & { port: number | null; manifestPath: string },
): Promise<GeneratedZip> {
  return oneGeneration(async () => {
    const { archive, port: configuredPort } = await runGenerationProcess(input, REBUILD_TIMEOUT_MS);
    const { zipPath, zipHash } = archive;
    const port = input.port ?? configuredPort;
    if (port == null)
      throw new Error(`generated zip is not published by a manifest. ${REBUILD_HINT}`);
    const zipUrl = await assertPublished({
      appDir: input.appDir,
      hostName: input.name,
      remoteName: input.name,
      alias: input.name,
      port,
      manifestPath: input.manifestPath,
      zipHash,
    });
    return { zipPath, zipHash, zipUrl };
  });
}

export async function assertPublished(input: {
  appDir: string;
  hostName: string;
  remoteName: string;
  alias: string;
  port: number;
  manifestPath: string;
  zipHash: string;
}): Promise<string> {
  const published = await hashManifestZip({
    appDir: input.appDir,
    hostName: input.hostName,
    remoteName: input.remoteName,
    alias: input.alias,
    manifestUrl: localManifestUrl(input.port, input.manifestPath),
  });
  if (published.zipHash !== input.zipHash)
    throw new Error("published zip does not match the generated archive");
  return published.zipUrl;
}
