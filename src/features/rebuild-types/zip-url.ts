import { createHash } from "node:crypto";
import { resolveZipUrl } from "../../entities/microfrontend/index.ts";
import { readLimitedBody } from "../../shared/http-body.ts";
import { DiagnosticError } from "../../shared/diagnostic-error.ts";

const TIMEOUT_MS = 10_000;

function jsonBody(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch (error) {
    throw new DiagnosticError(
      "manifest is not json",
      { stage: "manifest", reason: "invalid-json" },
      { cause: error },
    );
  }
}

export interface ManifestZipRequest {
  appDir: string;
  hostName: string;
  remoteName: string;
  alias: string;
  manifestUrl: string;
}

// The dev worker also serves /@mf-types.zip, on its own port. Use the manifest URL.
export async function manifestZipUrl(input: ManifestZipRequest): Promise<string> {
  if (!input.manifestUrl.includes(".json")) {
    throw new DiagnosticError(`Can not get ${input.remoteName}'s types archive url!`, {
      stage: "manifest",
      reason: "invalid-manifest-url",
    });
  }
  const zipUrl = resolveZipUrl(
    input.manifestUrl,
    jsonBody(await requestBody(input.manifestUrl, "manifest")),
  );
  if (!zipUrl)
    throw new DiagnosticError(`Can not get ${input.remoteName}'s types archive url!`, {
      stage: "manifest",
      reason: "missing-types-metadata",
    });
  return zipUrl;
}

export async function hashManifestZip(
  input: ManifestZipRequest,
): Promise<{ zipUrl: string; zipHash: string }> {
  const zipUrl = await manifestZipUrl(input);
  const body = Buffer.from(await requestBody(zipUrl, "archive"));
  if (body.length < 4 || body[0] !== 0x50 || body[1] !== 0x4b)
    throw new DiagnosticError("published response is not a zip", {
      stage: "archive",
      reason: "invalid-zip",
    });
  return { zipUrl, zipHash: createHash("sha256").update(body).digest("hex") };
}

async function requestBody(url: string, stage: "manifest" | "archive"): Promise<Uint8Array> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal });
    if (!response.ok)
      throw new DiagnosticError(
        `${stage === "manifest" ? "manifest" : "manifest zip url"} is not reachable (${response.status})`,
        { stage, reason: "http-status", status: response.status },
      );
    return await readLimitedBody(response);
  } catch (error) {
    if (error instanceof DiagnosticError) throw error;
    throw new DiagnosticError(
      error instanceof Error ? error.message : String(error),
      {
        stage,
        reason: signal.aborted ? "timeout" : "network",
        timeoutMs: signal.aborted ? TIMEOUT_MS : undefined,
      },
      { cause: error },
    );
  }
}
