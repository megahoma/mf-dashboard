export function localManifestUrl(port: number, manifestPath: string): string {
  const pathName = manifestPath.startsWith("/") ? manifestPath : `/${manifestPath}`;
  return `http://127.0.0.1:${port}${pathName}`;
}

export function parseHttpUrl(url: string | null): URL | null {
  if (url == null || url.trim() === "" || url.includes("${")) return null;
  try {
    const parsed = new URL(url.trim());
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname !== ""
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function isHttpUrl(url: string | null): url is string {
  return parseHttpUrl(url) !== null;
}
