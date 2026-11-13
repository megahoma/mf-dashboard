import { errorMessage } from "../../../shared/lib/errors.ts";
import { sha256 } from "../../../shared/lib/fingerprint.ts";
import { decodeJsonBody, readLimitedBody } from "../../../shared/lib/http-body.ts";
import { hasZipPrefix } from "../../../shared/lib/zip.ts";
import { DiagnosticError } from "../../../shared/models/diagnostic-error.ts";
import { TIMEOUT_MS } from "../config/zip-url.ts";
import type { ManifestZipRequest } from "../models/zip-url.ts";
import { resolveZipUrl } from "./probe-manifest.ts";

function jsonBody(body: Uint8Array): unknown {
  try {
    return decodeJsonBody(body);
  } catch (error) {
    throw new DiagnosticError(
      "manifest is not json",
      { stage: "manifest", reason: "invalid-json" },
      { cause: error },
    );
  }
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
  if (!hasZipPrefix(body))
    throw new DiagnosticError("published response is not a zip", {
      stage: "archive",
      reason: "invalid-zip",
    });
  return { zipUrl, zipHash: sha256(body) };
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
      errorMessage(error),
      {
        stage,
        reason: signal.aborted ? "timeout" : "network",
        timeoutMs: signal.aborted ? TIMEOUT_MS : undefined,
      },
      { cause: error },
    );
  }
}
