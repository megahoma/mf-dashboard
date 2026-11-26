import { terms, type DashboardTerms } from "../../../shared/config/index.ts";
import { isTimeoutError } from "../../../shared/lib/errors.ts";
export function manifestDocumentPath(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `/${safe === "" ? "manifest" : safe}.json`;
}

export function manifestPreviewText(json: unknown, body: Uint8Array | null): string {
  if (json !== null && json !== undefined) return `${JSON.stringify(json, null, 2)}\n`;
  if (body) return new TextDecoder().decode(body);
  return "";
}

export function manifestFailureMessage(
  error: unknown,
  status?: number,
  vocabulary: DashboardTerms = terms,
): string {
  if (status) return vocabulary.manifestHttpError.replace("{0}", String(status));
  return isTimeoutError(error) ? vocabulary.manifestTimeout : vocabulary.manifestNetworkError;
}
