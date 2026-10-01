import { createHash } from "node:crypto";
import { resolveZipUrl } from "../../entities/microfrontend/index.ts";
import { readLimitedBody } from "../../shared/http-body.ts";

const TIMEOUT_MS = 10_000;

function jsonBody(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch (error) {
    throw new Error("manifest is not json", { cause: error });
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
    throw new Error(`Can not get ${input.remoteName}'s types archive url!`);
  }
  const response = await fetch(input.manifestUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`manifest is not reachable (${response.status})`);
  const zipUrl = resolveZipUrl(input.manifestUrl, jsonBody(await readLimitedBody(response)));
  if (!zipUrl) throw new Error(`Can not get ${input.remoteName}'s types archive url!`);
  return zipUrl;
}

export async function hashManifestZip(
  input: ManifestZipRequest,
): Promise<{ zipUrl: string; zipHash: string }> {
  const zipUrl = await manifestZipUrl(input);
  const response = await fetch(zipUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`manifest zip url is not reachable (${response.status})`);
  const body = Buffer.from(await readLimitedBody(response));
  if (body.length < 4 || body[0] !== 0x50 || body[1] !== 0x4b)
    throw new Error("published response is not a zip");
  return { zipUrl, zipHash: createHash("sha256").update(body).digest("hex") };
}
