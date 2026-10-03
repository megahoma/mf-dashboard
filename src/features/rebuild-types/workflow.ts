import type { LocalApp, ProbeBook } from "../../entities/microfrontend/index.ts";
import { sourceIdentity, type ConfirmationStore } from "../../entities/federated-types/index.ts";
import { fillTemplate, runShell } from "../../shared/shell.ts";
import { localManifestUrl } from "../../shared/urls.ts";
import { resolveManifestPath, type ScriptSettings } from "../init-settings/index.ts";
import { installRemoteTypes } from "../refetch-types/remote.ts";
import { collectProducerEvidence, dependencyEvidence } from "./evidence.ts";
import { generateFederatedTypes } from "./generate.ts";
import { rebuildPlan } from "./plan.ts";
import { hashManifestZip } from "./zip-url.ts";

const REBUILD_TIMEOUT_MS = 5 * 60_000;

export interface RebuildContext {
  apps: readonly LocalApp[];
  book: ProbeBook;
  confirmations: ConfirmationStore;
  published: Map<string, string>;
  settings: ScriptSettings & { rebuildCommand: string };
  refetchCommand(): string;
  persist(): void | PromiseLike<void>;
  rebuilt(name: string): void;
}

export async function rebuildTypes(
  root: string,
  context: RebuildContext,
  operations = {
    collectProducerEvidence,
    installRemoteTypes,
    generateFederatedTypes,
    hashManifestZip,
    runShell,
  },
): Promise<void> {
  const { apps, book, confirmations, published } = context;
  const nodes = apps
    .filter((app) => app.generateTypes)
    .map((app) => operations.collectProducerEvidence(app, apps, book, confirmations));
  const plan = rebuildPlan(root, nodes);
  for (const step of plan) {
    if (step.action === "skip") continue;
    const app = apps.find((item) => item.name === step.name);
    if (!app) throw new Error(`missing local node: ${step.name}`);
    if (app.consumeTypes) {
      for (const remote of app.remotes) {
        const producer = apps.find((item) => item.name === remote.name);
        const manifestUrl =
          producer?.generateTypes && producer.port != null
            ? localManifestUrl(producer.port, producer.manifestPath)
            : remote.url;
        if (manifestUrl == null) throw new Error(`unreachable dependency: ${remote.name}`);
        const installed = await operations.installRemoteTypes(
          app,
          remote,
          manifestUrl,
          context.refetchCommand(),
        );
        confirmations.saveInstall(
          {
            consumer: app.name,
            alias: remote.alias,
            remoteName: remote.name,
            url: remote.url ?? manifestUrl,
          },
          installed.filesFingerprint,
          installed.zipHash,
        );
      }
      await context.persist();
    }
    const manifestPath = resolveManifestPath(context.settings, app.name);
    let zipHash: string;
    if (context.settings.rebuildCommand.trim() !== "") {
      const code = await operations.runShell(
        fillTemplate(context.settings.rebuildCommand, {
          folder: app.folder,
          name: app.name,
          port: app.port == null ? "" : String(app.port),
          tsconfig: app.tsconfig ?? "",
        }),
        app.folder,
        REBUILD_TIMEOUT_MS,
      );
      if (code !== 0) throw new Error(`rebuild command exited ${code}`);
      if (app.port == null) throw new Error("generated zip is not published by a manifest");
      zipHash = (
        await operations.hashManifestZip({
          appDir: app.folder,
          hostName: app.name,
          remoteName: app.name,
          alias: app.name,
          manifestUrl: localManifestUrl(app.port, manifestPath),
        })
      ).zipHash;
    } else {
      zipHash = (
        await operations.generateFederatedTypes({
          appDir: app.folder,
          configFile: app.configFile,
          port: app.port,
          manifestPath,
        })
      ).zipHash;
    }
    published.set(app.name, zipHash);
    const sources = sourceIdentity(app.folder, app.tsconfig, app.typesFolder);
    const { dependencyZipHashes } = dependencyEvidence(app, apps, book, published);
    confirmations.saveGeneration(app.name, sources.fingerprint, zipHash, dependencyZipHashes);
    await context.persist();
    context.rebuilt(app.name);
  }
}
