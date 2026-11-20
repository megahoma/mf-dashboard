import { sourceIdentity } from "../../../entities/federated-types/index.ts";
import { hashManifestZip } from "../../../entities/microfrontend/index.ts";
import { noLog } from "../../../shared/config/logging.ts";
import { safeError } from "../../../shared/lib/logging.ts";
import { runShell } from "../../../shared/lib/shell.ts";
import { localManifestUrl } from "../../../shared/lib/urls.ts";
import { resolveManifestPath } from "../../init-settings/index.ts";
import { installRemoteTypes } from "../../refetch-types/index.ts";
import type { RebuildContext } from "../models/workflow.ts";
import { runRebuildCommand } from "./command.ts";
import { collectProducerEvidence, dependencyEvidence } from "./evidence.ts";
import { generateFederatedTypes } from "./generate.mts";
import { inputsFingerprint } from "./inputs-fingerprint.ts";
import { chainDependencies, rebuildPlan } from "./plan.ts";

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
  const log = context.log ?? noLog;
  const persist = async () => {
    try {
      await context.persist();
    } catch (error) {
      log.event("error", "confirmations.save.failed", safeError(error));
      throw error;
    }
  };
  const local = new Map(apps.filter((app) => app.generateTypes).map((app) => [app.name, app]));
  const reachable = new Set<string>();
  const visit = (name: string) => {
    if (reachable.has(name)) return;
    reachable.add(name);
    const app = local.get(name);
    if (!app) throw new Error(`missing local node: ${name}`);
    for (const dependency of chainDependencies(app.remotes, local)) visit(dependency);
  };
  visit(root);
  const nodes = [...reachable].map((name) =>
    operations.collectProducerEvidence(local.get(name)!, apps, book, confirmations, log),
  );
  const plan = rebuildPlan(root, nodes);
  log.event("debug", "types.rebuild.plan", () => ({
    order: plan.map((step) => step.name).join(" -> "),
  }));
  for (const step of plan) {
    const evidence = nodes.find((node) => node.name === step.name);
    log.event("debug", "types.rebuild.step", {
      app: step.name,
      action: step.action,
      sourceFreshness: evidence?.sourceFreshness,
      zipReachable: evidence?.zipReachable,
      reason:
        step.action === "skip"
          ? "sources-and-dependencies-fresh"
          : "sources-zip-or-dependencies-not-fresh",
    });
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
          undefined,
          log,
          apps,
        );
        const url = remote.url ?? manifestUrl;
        confirmations.saveInstall(
          {
            consumer: app.name,
            alias: remote.alias,
            remoteName: remote.name,
            url,
          },
          installed.filesFingerprint,
          installed.zipHash,
          manifestUrl === url,
        );
      }
      await persist();
    }
    const manifestPath = resolveManifestPath(
      context.settings["mf-dashboard.apps"]?.[app.settingsKey ?? app.name]?.manifestPath,
      app.manifestPath,
    );
    const sources = sourceIdentity(app.folder, app.tsconfig, app.typesFolder, log);
    const inputs = inputsFingerprint(app, context.settings, null, sources.tsconfigFingerprint, []);
    let zipHash: string;
    if (context.settings.rebuildCommand.trim() !== "") {
      await runRebuildCommand(app, context.settings.rebuildCommand, log, operations.runShell);
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
          name: app.name,
          configFile: app.buildConfigFile ?? app.configFile,
          ...(app.bundler && { bundler: app.bundler }),
          ...(app.launchEnvironment ?? { envMode: context.settings.envMode }),
          port: app.port,
          manifestPath,
        })
      ).zipHash;
    }
    const after = sourceIdentity(app.folder, app.tsconfig, app.typesFolder, log);
    if (
      sources.fingerprint !== after.fingerprint ||
      inputs !== inputsFingerprint(app, context.settings, null, after.tsconfigFingerprint, [])
    ) {
      throw new Error(`Sources or build configuration changed during type generation: ${app.name}`);
    }
    log.event("debug", "types.generate.completed", { app: app.name });
    published.set(app.name, zipHash);
    const { dependencyZipHashes } = dependencyEvidence(app, apps, book, published);
    confirmations.saveGeneration(app.name, sources.fingerprint, zipHash, dependencyZipHashes);
    await persist();
    context.rebuilt(app.name);
  }
}
