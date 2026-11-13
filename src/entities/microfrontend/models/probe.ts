import type { LogContext } from "../../../shared/models/logging.ts";
import type { LocalApp } from "./config.ts";
import type { ManifestShared } from "./manifest-modules.ts";

export type Net = {
  connect(port: number): Promise<boolean>;
  get(
    url: string,
    init?: { ifModifiedSince?: number },
  ): Promise<{
    ok: boolean;
    status?: number;
    json: unknown | null;
    body: Uint8Array | null;
    lastModified: number | null;
    notModified?: boolean;
  }>;
};

export type ArtifactProbe = {
  manifestReachable: boolean;
  requestFailure?: "timeout" | "network" | `HTTP ${number}` | "HTTP error";
  buildVersion: string | null;
  zipUrl: string | null;
  zipMtime: number | null;
  zipHash: string | null;
  exposes: string[];
  shared: ManifestShared[];
};

export type ProbeResult = ArtifactProbe & {
  portOpen: boolean;
};

export type RemoteLink = {
  consumer: string;
  alias: string;
  remoteName: string;
  url: string | null;
};

export type LinkProbeResult = ArtifactProbe & {
  link: RemoteLink;
};

export type ProbeBook = {
  apps: Map<string, ProbeResult>;
  links: Map<string, LinkProbeResult>;
  extras: Map<string, ArtifactProbe>;
  zips: Map<string, ZipFact>;
};

export type ZipFact = {
  zipMtime: number | null;
  zipHash: string;
};

export type ProbeCycleInput = {
  apps: readonly LocalApp[];
  links: readonly RemoteLink[];
  extraManifestUrls: readonly string[];
  log?: LogContext;
  checkTypes?: boolean;
  typeLinks?: ReadonlySet<string>;
};

export type ZipProbe = Pick<ArtifactProbe, "zipMtime" | "zipHash">;

export type RequestQueue = <T>(work: () => Promise<T>) => Promise<T>;

export type ZipCache = {
  book: ProbeBook;
  cycle: Map<string, ZipFact>;
  pendingZips: Map<string, Promise<ZipProbe | null>>;
  manifests: Map<string, Promise<ArtifactProbe>>;
  request: RequestQueue;
  seen: Set<string>;
  log: LogContext;
  manifestRequests: number;
  zipRequests: number;
};

export type RemoteLinkIdentity = Pick<RemoteLink, "consumer" | "alias" | "remoteName">;
