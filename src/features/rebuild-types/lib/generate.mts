import { fork } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { hashManifestZip } from "../../../entities/microfrontend/index.ts";
import { createSerialQueue } from "../../../shared/lib/queue.ts";
import { isRecord } from "../../../shared/lib/record.ts";
import { stopProcessTree } from "../../../shared/lib/shell.ts";
import { localManifestUrl } from "../../../shared/lib/urls.ts";
import { DiagnosticError } from "../../../shared/models/diagnostic-error.ts";
import { LocatedError } from "../../../shared/models/source-problem.ts";
import { REBUILD_TIMEOUT_MS } from "../config/command.ts";
import { REBUILD_HINT } from "../config/generate.ts";
import {
  emptyGenerationPhaseTimings,
  type GeneratedZip,
  type GenerationInput,
  type GenerationMessage,
  type GenerationPhaseTimings,
  type GenerationProgress,
  type GenerationReply,
  type GenerationRequest,
  type GenerationResult,
  type GenerationTimings,
  type LocalGenerationInput,
  type LocalGenerationResult,
} from "../models/generate.ts";

const oneGeneration = createSerialQueue();
const phaseNames = Object.keys(emptyGenerationPhaseTimings());

function isDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isGenerationMessage(value: unknown): value is GenerationMessage {
  if (!isRecord(value)) return false;
  const { kind, timings, activePhase, result, error } = value;
  if (!isRecord(timings) || !phaseNames.every((phase) => isDuration(timings[phase]))) return false;
  if (kind === "mf-dashboard.generation-progress") {
    return (
      activePhase === undefined ||
      (typeof activePhase === "string" && phaseNames.includes(activePhase))
    );
  }
  if (kind !== "mf-dashboard.generation-reply") return false;
  if ("error" in value)
    return (
      typeof error === "string" &&
      (value.details === undefined || isRecord(value.details)) &&
      (value.problems === undefined || Array.isArray(value.problems))
    );
  if (!isRecord(result) || !isRecord(result.archive)) return false;
  const { zipPath, zipHash, inputsFingerprint, current } = result.archive;
  return (
    typeof zipPath === "string" &&
    typeof zipHash === "string" &&
    (typeof inputsFingerprint === "string" || inputsFingerprint === null) &&
    typeof current === "boolean" &&
    (typeof result.port === "number" || result.port === null)
  );
}

export function generateLocalFederatedTypes(
  input: LocalGenerationInput,
  timeoutMs = REBUILD_TIMEOUT_MS,
  onFailureTimings?: (timings: GenerationTimings) => void,
): Promise<LocalGenerationResult> {
  const queuedAt = performance.now();
  return oneGeneration(async () => {
    const started = performance.now();
    const queueMs = Math.round(started - queuedAt);
    let phases = emptyGenerationPhaseTimings();
    const timings = () => ({
      ...phases,
      queueMs,
      processMs: Math.round(performance.now() - started),
    });
    try {
      const { archive } = await runGenerationProcess(input, timeoutMs, (value) => (phases = value));
      return { ...archive, timings: timings() };
    } catch (error) {
      onFailureTimings?.(timings());
      throw error;
    }
  });
}

function runGenerationProcess(
  input: GenerationRequest,
  timeoutMs: number,
  onTimings?: (timings: GenerationPhaseTimings) => void,
): Promise<GenerationResult> {
  let progress: GenerationProgress = { timings: emptyGenerationPhaseTimings() };
  let progressReceivedAt = 0;
  let timedOutAt: number | undefined;
  return new Promise<GenerationResult>((resolve, reject) => {
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
    const timer = setTimeout(() => {
      timedOutAt = performance.now();
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
    child.on("message", (message: unknown) => {
      if (timedOutAt !== undefined || reply || !isGenerationMessage(message)) return;
      if (message.kind === "mf-dashboard.generation-progress") {
        progressReceivedAt = performance.now();
        progress = message;
      } else {
        reply = message;
        progress = { timings: message.timings };
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (timedOutAt === undefined) reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOutAt !== undefined) return;
      if (reply && "error" in reply) {
        if (reply.problems?.length) reject(new LocatedError(reply.error, reply.problems));
        else
          reject(
            reply.details
              ? new DiagnosticError(reply.error, reply.details)
              : new Error(reply.error),
          );
      } else if (code === 0 && reply) resolve(reply.result);
      else reject(new Error(`Type generator exited (${signal ?? code})`));
    });
    child.send(input, (error) => {
      if (error && timedOutAt === undefined) {
        clearTimeout(timer);
        child.kill();
        reject(error);
      }
    });
  }).finally(() => {
    if (!onTimings) return;
    const { prepareMs, inputsMs, compileMs, zipMs } = progress.timings;
    const timings = { prepareMs, inputsMs, compileMs, zipMs };
    if (progress.activePhase) {
      timings[progress.activePhase] += Math.round(
        (timedOutAt ?? performance.now()) - progressReceivedAt,
      );
    }
    onTimings(timings);
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
