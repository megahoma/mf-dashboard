export function manifestDocumentPath(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `/${safe === "" ? "manifest" : safe}.json`;
}

export function manifestPreviewText(json: unknown, body: Uint8Array | null): string {
  if (json !== null && json !== undefined) return `${JSON.stringify(json, null, 2)}\n`;
  if (body) return new TextDecoder().decode(body);
  return "";
}

export function manifestFailureMessage(error: unknown, status?: number): string {
  if (status) return `MF dashboard: manifest is not reachable (HTTP ${status})`;
  if (error instanceof Error && (error.name === "TimeoutError" || error.message === "timeout"))
    return "MF dashboard: manifest request timed out";
  return "MF dashboard: manifest network error";
}
