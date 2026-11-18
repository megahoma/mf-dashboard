import { isLoopbackAtPort, parseHttpUrl } from "../../../shared/lib/urls.ts";
import { MAX_CONFIG_LOCATION_LENGTH } from "../config/config.ts";
import type { ConfigCandidate, Value } from "../models/config.ts";
import { flag, object, string } from "./static-values.ts";

export function joinManifestPath(prefix: string, file: string): string {
  return `/${prefix}/${file}`.replace(/\/{2,}/g, "/");
}

export function viteManifestBase(value: Value): string {
  const input = string(value);
  if (!input || input.length > MAX_CONFIG_LOCATION_LENGTH) return "/";
  const base = input.trim();
  if (!base || base.startsWith(".")) return "/";
  try {
    // Vite uses the pathname of the configured base on the local server.
    const { pathname } = new URL(base, "http://localhost");
    return pathname.startsWith("/") ? pathname : `/${pathname}`;
  } catch {
    return "/";
  }
}

export function joinViteManifestPath(base: string, file: string): string {
  return `${base.endsWith("/") ? base : `${base}/`}${file}`;
}

export function rsbuildDevManifestResolver(
  config: Value,
  port: number | null,
): ConfigCandidate["resolveRsbuildDevManifest"] {
  if (!object(config) || !object(config.dev)) return undefined;
  const server = config.server;
  if (server !== undefined && !object(server)) return undefined;
  if (server?.port !== undefined && portValue(server.port) === null) return undefined;
  const serverBase = server?.base;
  if (serverBase !== undefined && typeof serverBase !== "string") return undefined;
  if (serverBase && serverBase.length > MAX_CONFIG_LOCATION_LENGTH) return undefined;
  const assetPrefix = string(config.dev.assetPrefix);
  if (!assetPrefix || assetPrefix.length > MAX_CONFIG_LOCATION_LENGTH) return undefined;
  const configured = assetPrefix.trim();
  if (!configured || /[?#\\]/.test(configured)) return undefined;
  const prefix = port === null ? configured : configured.replaceAll("<port>", String(port));
  const schemeRelative = prefix.startsWith("//");
  const https = server?.https;
  if (schemeRelative && https !== undefined && typeof https !== "boolean" && !object(https))
    return undefined;
  const protocol = flag(https, false) ? "https:" : "http:";
  const origin = `${protocol}//127.0.0.1`;
  const urlPrefix = schemeRelative ? protocol + prefix : prefix;
  const rootRelative = urlPrefix.startsWith("/");
  const url = parseHttpUrl(rootRelative ? origin + urlPrefix : urlPrefix);
  if (!url || url.username || url.password) return undefined;
  if (!rootRelative && (port === null || !isLoopbackAtPort(url, port))) return undefined;

  const base = serverBase?.endsWith("/") ? serverBase : `${serverBase ?? ""}/`;
  return (file) => {
    if (url.pathname.length + file.length + 2 > MAX_CONFIG_LOCATION_LENGTH) return undefined;
    const route = joinManifestPath(url.pathname, file);
    const pathname = parseHttpUrl(origin + route)?.pathname;
    if (pathname?.startsWith(base) && !mayProxyManifest(server?.proxy, pathname)) return route;
  };
}

function mayProxyManifest(proxy: Value, pathname: string): boolean {
  if (!proxy) return false;
  // Only plain path prefixes can rule out a proxy without running the config.
  if (!object(proxy)) return true;
  return Object.entries(proxy).some(([prefix, rule]) => {
    if (
      prefix.length > MAX_CONFIG_LOCATION_LENGTH ||
      !/^\/[\w./%~-]*$/.test(prefix) ||
      pathname.startsWith(prefix)
    )
      return true;
    if (typeof rule === "string") return false;
    return (
      !object(rule) || ["context", "pathFilter", "bypass"].some((key) => Object.hasOwn(rule, key))
    );
  });
}

export function portValue(value: Value): number | null {
  const port =
    typeof value === "number"
      ? value
      : typeof value === "string" &&
          value.length <= MAX_CONFIG_LOCATION_LENGTH &&
          /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}
