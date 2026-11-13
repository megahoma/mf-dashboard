import path from "node:path";
import {
  describeLink,
  readInstalledEvidence,
  readInstalledEvidenceAsync,
  type ConfirmationStore,
  type InstalledEvidence,
} from "../../../entities/federated-types/index.ts";
import {
  appsByName,
  linkProbeId,
  type LocalApp,
  type ProbeBook,
  type RemoteLink,
} from "../../../entities/microfrontend/index.ts";
import type { InstallCheck } from "../../../features/observe-types/index.ts";
import {
  collectProducerEvidence,
  collectProducerEvidenceAsync,
  type ProducerSnapshot,
} from "../../../features/rebuild-types/index.ts";
import { refetchTarget } from "../../../features/refetch-types/index.ts";
import { resolveLogFields, safeError } from "../../../shared/lib/logging.ts";
import type { LogContext, LogFields } from "../../../shared/models/logging.ts";
import { readWorkspaceSettings } from "../lib/workspace-settings.ts";
import type { DashboardSession } from "./session.ts";
import type { TypeEvidence, TypeSnapshot } from "./type-observation-types.ts";

export class DashboardTypeObservation {
  private readonly producerCache = new Map<string, ProducerSnapshot>();
  private readonly installedCache = new Map<string, InstalledEvidence>();
  private readonly sourceErrors = new Map<string, unknown>();
  private readonly warnings = new Set<string>();
  private readonly typeCache = new Map<string, TypeSnapshot>();
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

  invalidateProducer(name: string): void {
    this.producerCache.delete(name);
    this.sourceErrors.delete(name);
  }

  pruneLinks(active: ReadonlySet<string>): void {
    for (const id of this.typeCache.keys()) if (!active.has(id)) this.typeCache.delete(id);
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

  statusFor(link: RemoteLink): ReturnType<typeof describeLink> {
    const consumer = this.session.loaded.find((app) => app.name === link.consumer);
    if (consumer?.consumeTypes === false) return "none";
    const cached = this.typeSnapshot(link);
    if (cached) return cached.status;
    if (!this.canCheck(link) || this.preparing) return "unchecked";
    const status = this.observe(link);
    this.typeCache.set(linkProbeId(link), {
      status,
      checkedAt: Date.now(),
      signature: this.typeSignature(link),
    });
    return status;
  }

  private typeSignature(link: RemoteLink): string {
    const consumer = this.session.loaded.find((app) => app.name === link.consumer);
    const producer = this.session.loaded.find((app) => app.name === link.remoteName);
    return JSON.stringify([
      consumer?.folder,
      consumer?.configFile,
      consumer?.consumeTypes,
      consumer?.typesFolder,
      producer?.folder,
      producer?.configFile,
      producer?.port,
      producer?.manifestPath,
      producer?.generateTypes,
      producer?.tsconfig,
      producer?.typesFolder,
    ]);
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
    installed = new Map<string, InstalledEvidence>(),
    log: LogContext = this.log,
  ): Promise<TypeEvidence> {
    const producers = new Map<string, ProducerSnapshot>();
    const errors = new Map<string, unknown>();
    const byName = appsByName(apps);
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
            await collectProducerEvidenceAsync(producer, apps, book, this.confirmations, log),
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

  private observe(link: RemoteLink): ReturnType<typeof describeLink> {
    const consumer = this.session.loaded.find((app) => app.name === link.consumer);
    const producer = this.session.loaded.find(
      (app) => app.name === link.remoteName && app.port != null,
    );
    if (!consumer) return "unknown";
    const probe = this.session.book.links.get(linkProbeId(link));
    let evidence: ProducerSnapshot | undefined;
    if (producer && producer.generateTypes && consumer.consumeTypes) {
      if (this.sourceErrors.has(producer.name)) {
        this.warnOnce(`${producer.name}\0source`, "types.sources.unreadable", {
          producer: producer.name,
          ...safeError(this.sourceErrors.get(producer.name)),
        });
        return "unknown";
      }
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
        } catch (error) {
          this.warnOnce(`${producer.name}\0source`, "types.sources.unreadable", {
            producer: producer.name,
            ...safeError(error),
          });
          return "unknown";
        }
        this.producerCache.set(producer.name, evidence);
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
    return describeLink(
      {
        consumeTypes: consumer.consumeTypes,
        producer: producer
          ? {
              generateTypes: producer.generateTypes,
              sourceSavedAt: evidence?.sourceSavedAt ?? null,
            }
          : null,
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
  }
}
