import { terms, type DashboardTerms } from "../../shared/config/index.ts";

export type StatusKind =
  | "listen"
  | "silent"
  | "stale"
  | "unfetched"
  | "invalidUrl"
  | "otherHost"
  | "otherPort"
  | "answers"
  | "noAnswer";

export interface StatusInput {
  role: "app" | "link" | "external";
  port: number | null;
  portOpen: boolean;
  manifestEnabled: boolean;
  buildVersion: string | null;
  url: string | null;
  typesState: "none" | "ok" | "stale-source" | "unfetched" | "manual" | "unknown";
  requestFailure?: string | null;
}

const localHosts = new Set(["localhost", "127.0.0.1"]);

function blankUrl(url: string | null): boolean {
  return url == null || url.trim() === "";
}

function httpUrl(url: string | null): URL | null {
  // The URL parser accepts some unsubstituted env tokens, such as http://${HOST}/...
  if (url == null || url.trim() === "" || url.includes("${")) return null;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.hostname === "") return null;
    return parsed;
  } catch {
    return null;
  }
}

function urlPort(url: URL): number {
  if (url.port !== "") return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

export function classify(input: StatusInput): StatusKind {
  if (input.role === "app") return input.portOpen ? "listen" : "silent";
  if (input.role === "external") {
    if (!httpUrl(input.url)) return "invalidUrl";
    return input.portOpen ? "answers" : "noAnswer";
  }
  // Silent only when the local port is declared and closed.
  if (input.port !== null && !input.portOpen) return "silent";
  if (input.typesState === "stale-source") return "stale";
  if (input.typesState === "unfetched") return "unfetched";
  const url = httpUrl(input.url);
  if (!url) return "invalidUrl";
  if (!localHosts.has(url.hostname)) return "otherHost";
  if (input.port === null || urlPort(url) !== input.port) return "otherPort";
  return "listen";
}

export function invalidUrlHint(
  url: string | null,
  vocabulary: DashboardTerms = terms,
): string | null {
  if (httpUrl(url)) return null;
  return blankUrl(url) ? vocabulary.urlMissing : vocabulary.urlMalformed;
}

function grayPort(port: number | null): string | null {
  // Declared ports 80 and 443 stay off the gray line.
  if (port === null || port === 80 || port === 443) return null;
  return `:${port}`;
}

function dotted(parts: Array<string | null>): string {
  return parts.filter((part): part is string => part !== null && part !== "").join(" · ");
}

export function grayLabel(
  kind: StatusKind,
  input: StatusInput,
  vocabulary: DashboardTerms = terms,
): string {
  if (kind === "answers" || kind === "noAnswer") {
    return dotted([httpUrl(input.url)?.hostname ?? null, vocabulary[kind]]);
  }
  if (kind === "invalidUrl" && input.role === "external") return vocabulary.invalidUrl;
  const version =
    kind === "listen" && input.manifestEnabled && input.buildVersion ? input.buildVersion : null;
  return dotted([grayPort(input.port), vocabulary[kind], version]);
}

export interface RowModel {
  kind: StatusKind;
  description: string;
  tooltip: string;
}

export function rowModel(
  input: StatusInput & { folder?: string },
  vocabulary: DashboardTerms = terms,
): RowModel {
  const kind = classify(input);
  const description = grayLabel(kind, input, vocabulary);
  const lines: string[] = [];
  if (input.folder) lines.push(`${vocabulary.folder}: ${input.folder}`);
  if (input.role !== "external" && input.port !== null)
    lines.push(`${vocabulary.localPort}: ${input.port}`);
  if (input.url && input.url.trim() !== "") lines.push(`${vocabulary.url}: ${input.url}`);
  const hint = input.role === "app" ? null : invalidUrlHint(input.url, vocabulary);
  if (hint) lines.push(hint);
  if (input.requestFailure && kind !== "invalidUrl") {
    lines.push(
      input.requestFailure === "timeout"
        ? vocabulary.requestTimeout
        : input.requestFailure === "network"
          ? vocabulary.requestNetworkError
          : input.requestFailure === "HTTP error"
            ? vocabulary.requestHttpError
            : input.requestFailure,
    );
  }
  lines.push(vocabulary[kind]);
  return { kind, description, tooltip: lines.join("\n") };
}
