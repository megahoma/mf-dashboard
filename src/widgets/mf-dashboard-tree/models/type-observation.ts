import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  describeLink,
  readInstalledEvidence,
  readInstalledEvidenceAsync,
  type ConfirmationStore,
  type InstalledEvidence,
  type LinkTypeObservation,
  type SourceIdentity,
} from "../../../entities/federated-types/index.ts";
import {
  indexedApps,
  linkProbeId,
  type LocalApp,
  type ProbeBook,
  type RemoteLink,
} from "../../../entities/microfrontend/index.ts";
import type { InstallCheck } from "../../../features/observe-types/index.ts";
import {
  collectProducerEvidence,
  collectProducerEvidenceAsync,
  createPublishedZipComparison,
  type ProducerSnapshot,
} from "../../../features/rebuild-types/index.ts";
import { refetchTarget } from "../../../features/refetch-types/index.ts";
import { resolveLogFields, safeError } from "../../../shared/lib/logging.ts";
import type { LogContext, LogFields } from "../../../shared/models/logging.ts";
import { readWorkspaceSettings } from "../lib/workspace-settings.ts";
import type { DashboardSession } from "./session.ts";
import type { TypeEvidence, TypeSnapshot } from "./type-observation-types.ts";

export class DashboardTypeObservation {
  private readonly compareZip = createPublishedZipComparison();
  private readonly producerCache = new Map<string, ProducerSnapshot>();
  private readonly installedCache = new Map<string, InstalledEvidence>();
  private readonly sourceErrors = new Map<string, unknown>();
  private readonly warnings = new Set<string>();
  private readonly typeCache = new Map<string, TypeSnapshot>();
  private signatureApps: readonly LocalApp[] | undefined;
  private readonly signatures = new Map<string, { consumer: string; producer: string }>();
  readonly installChecks = new Map<string, InstallCheck>();
  private readonly session: DashboardSession;
  private readonly confirmations: ConfirmationStore;
  private readonly canCheck: (link: RemoteLink) => boolean;
  log: LogContext;
  preparing = false;

  constructor(
    session: DashboardSession,
    confirmations: ConfirmationStore,
    log: LogContext,
    canCheck: (link: RemoteLink) => boolean,
  ) {
    this.session = session;
    this.confirmations = confirmations;
    this.log = log;
    this.canCheck = canCheck;
  }

  checkedAt(link: RemoteLink): number | null {
    return this.typeSnapshot(link)?.checkedAt ?? null;
  }

  clear(resetTypes: boolean, links?: ReadonlySet<string>): void {
    if (resetTypes) {
      if (links) this.invalidateLinks(links);
      else this.typeCache.clear();
    }
    this.producerCache.clear();
    this.installedCache.clear();
    this.sourceErrors.clear();
  }

  apply({ producers, installed, errors }: TypeEvidence): void {
    for (const [name, value] of producers) this.producerCache.set(name, value);
    for (const [destination, value] of installed) this.installedCache.set(destination, value);
    for (const [name, value] of errors) this.sourceErrors.set(name, value);
  }

  invalidateLinks(ids: Iterable<string>): void {
    for (const id of ids) this.typeCache.delete(id);
  }

  recordInstall(link: RemoteLink, zipHash: string): void {
    const id = linkProbeId(link);
    const previous = this.typeSnapshot(link)?.observation;
    this.typeCache.set(id, {
      observation: {
        status: previous?.status === "stale-source" ? "stale-source" : "ok",
        archiveMatch: "matches",
        sourceFreshness:
          this.session.book.links.get(id)?.zipHash === zipHash
            ? (previous?.sourceFreshness ?? "unknown")
            : "unknown",
      },
      checkedAt: Date.now(),
      signature: this.typeSignature(link),
    });
  }

  refreshLinks(links: readonly RemoteLink[], explicit: boolean): boolean {
    let changed = false;
    for (const link of links) {
      const id = linkProbeId(link);
      const previous = this.typeCache.get(id);
      if ((!previous && !explicit) || !this.canCheck(link)) continue;
      this.typeCache.delete(id);
      this.detailsFor(link);
      const next = this.typeCache.get(id);
      changed ||= !isDeepStrictEqual(previous?.observation, next?.observation);
    }
    return changed;
  }

  invalidateProducer(name: string): void {
    this.producerCache.delete(name);
    this.sourceErrors.delete(name);
  }

  pruneLinks(active: ReadonlySet<string>): void {
    for (const id of this.typeCache.keys()) if (!active.has(id)) this.typeCache.delete(id);
    for (const id of this.installChecks.keys()) if (!active.has(id)) this.installChecks.delete(id);
  }

  pruneWarnings(apps: readonly LocalApp[]): void {
    const active = new Set(
      apps.flatMap((app) =>
        app.remotes.flatMap(({ alias }) => [
          `${app.name}\0${alias}\0path`,
          `${app.name}\0${alias}\0read`,
        ]),
      ),
    );
    for (const key of this.warnings) if (!active.has(key)) this.warnings.delete(key);
  }

  detailsFor(link: RemoteLink): LinkTypeObservation {
    const consumer = indexedApps(this.session.loaded).get(link.consumer);
    if (consumer?.consumeTypes === false)
      return { status: "none", archiveMatch: "unknown", sourceFreshness: "unknown" };
    const cached = this.typeSnapshot(link);
    if (cached) return cached.observation;
    if (!this.canCheck(link) || this.preparing || this.session.probeRunning)
      return { status: "unchecked", archiveMatch: "unknown", sourceFreshness: "unknown" };
    const observation = this.observe(link);
    this.typeCache.set(linkProbeId(link), {
      observation,
      checkedAt: Date.now(),
      signature: this.typeSignature(link),
    });
    return observation;
  }

  private typeSignature(link: RemoteLink): string {
    const apps = this.session.loaded;
    if (this.signatureApps !== apps) {
      this.signatureApps = apps;
      this.signatures.clear();
      for (const app of apps) {
        this.signatures.set(app.name, {
          consumer: JSON.stringify([app.folder, app.configFile, app.consumeTypes, app.typesFolder]),
          producer: JSON.stringify([
            app.folder,
            app.configFile,
            app.port,
            app.manifestPath,
            app.generateTypes,
            app.tsconfig,
            app.typesFolder,
          ]),
        });
      }
    }
    return `${this.signatures.get(link.consumer)?.consumer ?? ""}\0${this.signatures.get(link.remoteName)?.producer ?? ""}`;
  }

  private typeSnapshot(link: RemoteLink) {
    const id = linkProbeId(link);
    const cached = this.typeCache.get(id);
    if (cached && cached.signature !== this.typeSignature(link)) {
      this.typeCache.delete(id);
      return undefined;
    }
    return cached;
  }

  async prepare(
    apps: readonly LocalApp[],
    links: readonly RemoteLink[],
    book: ProbeBook,
    options: {
      installed?: Map<string, InstalledEvidence>;
      log?: LogContext;
      allowDownload?: boolean;
      source?: { app: LocalApp; identity: SourceIdentity };
    } = {},
  ): Promise<TypeEvidence> {
    const { installed = new Map(), log = this.log, allowDownload = true, source } = options;
    const producers = new Map<string, ProducerSnapshot>();
    const errors = new Map<string, unknown>();
    const byName = indexedApps(apps);
    for (const link of links) {
      if (!this.canCheck(link)) continue;
      const consumer = byName.get(link.consumer);
      if (!consumer?.consumeTypes) continue;
      const producer = byName.get(link.remoteName);
      if (!producer || producer.port == null) continue;
      if (producer.generateTypes && !producers.has(producer.name) && !errors.has(producer.name)) {
        try {
          producers.set(
            producer.name,
            await collectProducerEvidenceAsync(
              producer,
              apps,
              book,
              this.confirmations,
              this.compareZip,
              log,
              allowDownload,
              source?.app === producer ? source.identity : undefined,
            ),
          );
        } catch (error) {
          errors.set(producer.name, error);
        }
      }
      let destination: string;
      try {
        destination = path.resolve(
          refetchTarget(consumer.folder, link.alias, consumer.typesFolder),
        );
      } catch {
        continue;
      }
      if (!installed.has(destination)) {
        try {
          installed.set(destination, await readInstalledEvidenceAsync(destination, log));
        } catch {
          installed.set(destination, { folderExists: true, filesFingerprint: "" });
        }
      }
    }
    return { producers, installed, errors };
  }

  warnOnce(key: string, event: string, fields: LogFields): void {
    if (this.warnings.has(key)) return;
    this.warnings.add(key);
    this.log.event("warn", event, fields);
  }

  private observe(link: RemoteLink): LinkTypeObservation {
    const byName = indexedApps(this.session.loaded);
    const consumer = byName.get(link.consumer);
    const candidate = byName.get(link.remoteName);
    const producer = candidate?.port != null ? candidate : undefined;
    if (!consumer)
      return { status: "unknown", archiveMatch: "unknown", sourceFreshness: "unknown" };
    const probe = this.session.book.links.get(linkProbeId(link));
    let evidence: ProducerSnapshot | undefined;
    if (producer && producer.generateTypes && consumer.consumeTypes) {
      if (this.sourceErrors.has(producer.name)) {
        this.warnOnce(`${producer.name}\0source`, "types.sources.unreadable", {
          producer: producer.name,
          ...safeError(this.sourceErrors.get(producer.name)),
        });
      } else {
        evidence = this.producerCache.get(producer.name);
        if (!evidence) {
          try {
            evidence = collectProducerEvidence(
              producer,
              this.session.loaded,
              this.session.book,
              this.confirmations,
              this.log,
            );
            this.warnings.delete(`${producer.name}\0source`);
            this.producerCache.set(producer.name, evidence);
          } catch (error) {
            this.warnOnce(`${producer.name}\0source`, "types.sources.unreadable", {
              producer: producer.name,
              ...safeError(error),
            });
          }
        }
      }
    }
    let destination: string | null = null;
    if (consumer.consumeTypes) {
      try {
        destination = refetchTarget(consumer.folder, link.alias, consumer.typesFolder);
        this.warnings.delete(`${consumer.name}\0${link.alias}\0path`);
      } catch (error) {
        this.warnOnce(`${consumer.name}\0${link.alias}\0path`, "types.path.invalid", {
          consumer: consumer.name,
          alias: link.alias,
          ...safeError(error),
        });
      }
    }
    let installed: InstalledEvidence;
    try {
      installed =
        (destination && this.installedCache.get(path.resolve(destination))) ||
        readInstalledEvidence(destination, this.log);
      if (installed.filesFingerprint === "")
        this.warnOnce(`${consumer.name}\0${link.alias}\0read`, "types.installed.unreadable", {
          consumer: consumer.name,
          alias: link.alias,
        });
      if (installed.filesFingerprint !== "")
        this.warnings.delete(`${consumer.name}\0${link.alias}\0read`);
    } catch (error) {
      this.warnOnce(`${consumer.name}\0${link.alias}\0read`, "types.installed.unreadable", {
        consumer: consumer.name,
        alias: link.alias,
        ...safeError(error),
      });
      installed = { folderExists: true, filesFingerprint: "" };
    }
    const check = this.installChecks.get(linkProbeId(link));
    const archiveMatches =
      check?.zipHash === probe?.zipHash &&
      check?.url === link.url &&
      check?.filesFingerprint === installed.filesFingerprint
        ? check?.matches
        : undefined;
    const observation = describeLink(
      {
        consumeTypes: consumer.consumeTypes,
        producer: producer
          ? {
              generateTypes: producer.generateTypes,
              sourceSavedAt: evidence?.sourceSavedAt ?? null,
            }
          : null,
        sourceUnavailable: producer?.generateTypes === true && evidence === undefined,
        producerZipMtime: evidence?.zipMtime ?? null,
        linkZipHash: probe?.zipHash ?? null,
        linkZipReachable: probe?.zipUrl != null && probe.zipHash != null,
        linkUrl: link.url,
        generationConfirmed: evidence?.generationConfirmed ?? false,
        installConfirmation: this.confirmations.install(link),
        archiveMatches,
        checkedAt: Date.now(),
        typesSettleMs: readWorkspaceSettings().typesSettleMs,
        installed,
      },
      {
        operation: (source) => this.log.operation(source),
        event: (level, event, fields) =>
          this.log.event(level, event, () => ({
            consumer: link.consumer,
            alias: link.alias,
            remote: link.remoteName,
            ...resolveLogFields(fields),
          })),
      },
    );
    // The producer's local manifest and the consumer's remote can serve different ZIPs.
    const sameZip = probe?.zipHash != null && probe.zipHash === evidence?.zipHash;
    return {
      ...observation,
      archiveMatch: destination ? observation.archiveMatch : "unknown",
      sourceFreshness: sameZip ? observation.sourceFreshness : "unknown",
    };
  }
}
