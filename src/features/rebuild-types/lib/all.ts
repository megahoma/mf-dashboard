import path from "node:path";
import {
  EMPTY_TYPES_FINGERPRINT,
  installLocalTypesArchive,
  readInstalledEvidenceAsync,
  sourceIdentityAsync,
} from "../../../entities/federated-types/index.ts";
import {
  readModeEnv,
  remoteLink,
  type LocalApp,
  type RemoteLink,
} from "../../../entities/microfrontend/index.ts";
import { noLog } from "../../../shared/config/logging.ts";
import { errorMessage } from "../../../shared/lib/errors.ts";
import { safeError } from "../../../shared/lib/logging.ts";
import { LocatedError } from "../../../shared/models/source-problem.ts";
import { dependencyTypesTarget, installRemoteTypes } from "../../refetch-types/index.ts";
import {
  createRebuildAllReport,
  type RebuildAllContext,
  type RebuildAllReport,
  type RebuildAppStatus,
} from "../models/all.ts";
import type { GenerationTimings, LocalGeneratedZip } from "../models/generate.ts";
import { runRebuildCommand } from "./command.ts";
import { generateLocalFederatedTypes } from "./generate.mts";
import { generatedZip, zipRevision } from "./generated-zip.ts";
import { inputsFingerprint, rebuildConfigFingerprint } from "./inputs-fingerprint.ts";
import { workspaceTypesPlan } from "./workspace-plan.ts";

const operations = { generateLocalFederatedTypes, runRebuildCommand, installRemoteTypes };
const CHANGED_CONFIG = "Sources or build configuration changed during type generation";

export async function rebuildAllTypes(
  context: RebuildAllContext,
  io: typeof operations = operations,
): Promise<RebuildAllReport> {
  const planStarted = Date.now();
  const { order, cycles, conflicts, apps } = workspaceTypesPlan(context.apps, context.target);
  const planned = new Set(order.map(({ app }) => app.name));
  context.status?.(
    apps
      .filter(({ name }) => !conflicts.has(name))
      .map(({ name, settingsKey }) => ({
        app: name,
        settingsKey,
        status: planned.has(name) ? "queued" : "not-applicable",
      })),
  );
  const { confirmations } = context;
  const log = context.log ?? noLog;
  const report = context.report ?? createRebuildAllReport();
  for (const [name, apps] of conflicts) {
    const updates = apps.map((app) => ({
      app: name,
      settingsKey: app.settingsKey ?? app.folder,
      status: "skipped" as const,
      reason: `Duplicate Module Federation name: ${name} (${app.configFile})`,
    }));
    report.skipped.push(
      ...updates.map(({ settingsKey, reason }) => ({ app: settingsKey, reason })),
    );
    context.status?.(updates);
  }
  const localNames = new Set(
    context.apps.filter((app) => app.generateTypes && app.port != null).map((app) => app.name),
  );
  const zips = new Map<string, LocalGeneratedZip>();
  const configSnapshots = new Map<LocalApp, string>();
  const configErrors = new Map<LocalApp, unknown>();
  for (const { app } of order) {
    if (app.configInputs?.length || app.configDependencies?.length) {
      try {
        configSnapshots.set(
          app,
          app.rebuildConfigStamp ?? rebuildConfigFingerprint(app, undefined, true),
        );
      } catch (error) {
        configErrors.set(app, error);
      }
    }
  }
  const verifyConfig = async (app: LocalApp) => {
    const snapshot = configSnapshots.get(app);
    if (!snapshot) return;
    const current = await (context.rebuildConfigStamp?.(app) ?? rebuildConfigFingerprint(app));
    if (snapshot !== current) throw new Error(CHANGED_CONFIG);
  };
  let dirty = false;
  log.event("info", "types.rebuild.all.plan", {
    apps: order.length,
    cycles: cycles.size,
    conflicts: conflicts.size,
    durationMs: Date.now() - planStarted,
    target: context.target,
  });
  for (const [index, { app, generate, links, dependencies }] of order.entries()) {
    context.progress?.(app.name, index, order.length);
    const installStart = report.installed.length;
    const status = (
      state: RebuildAppStatus["status"],
      issue?: RebuildAllReport["failed"][number],
    ) => {
      if (!context.status) return;
      const installed = report.installed.slice(installStart).map(({ alias }) => alias);
      context.status([
        { ...issue, app: app.name, settingsKey: app.settingsKey, status: state, installed },
      ]);
    };
    const appStarted = Date.now();
    const phases = {
      installLocalMs: 0,
      installRemoteMs: 0,
      prepareMs: 0,
      generateMs: 0,
      verifyMs: 0,
    };
    let outcome: RebuildAppStatus["status"] = "failed";
    let generationTimings: GenerationTimings | undefined;
    const recordApp = () => {
      log.event("info", "types.rebuild.all.app", {
        app: app.name,
        status: outcome,
        index: index + 1,
        total: order.length,
        durationMs: Date.now() - appStarted,
        ...phases,
        prepareGenerationMs: generationTimings?.prepareMs,
        inputsMs: generationTimings?.inputsMs,
        compileMs: generationTimings?.compileMs,
        zipMs: generationTimings?.zipMs,
        queueMs: generationTimings?.queueMs,
        processMs: generationTimings?.processMs,
      });
    };
    const missing = links.find(({ url }) => url === null);
    const blocked = dependencies.find((name) => !zips.has(name));
    const reason =
      cycles.get(app.name) ??
      (missing ? `Unresolved URL for ${missing.remote.alias}` : undefined) ??
      (blocked ? `Dependency ${blocked} could not be updated` : undefined);
    if (reason !== undefined) {
      report.skipped.push({ app: app.name, reason });
      status("skipped", { app: app.name, reason });
      log.event("warn", "types.rebuild.all.skipped", { app: app.name, reason });
      outcome = "skipped";
      recordApp();
      continue;
    }
    try {
      status("running");
      if (configErrors.has(app)) throw configErrors.get(app);
      await measured(
        async () => verifyConfig(app),
        (durationMs) => (phases.prepareMs += durationMs),
      );
      const command = generate ? context.rebuildCommand.trim() : "";
      const override = command ? context.zipPathOverride(app)?.trim() : undefined;
      const customZipPath = command
        ? override
          ? path.resolve(app.folder, override)
          : (app.generatedZipPath ?? null)
        : null;
      if (command && customZipPath === null)
        throw new Error(
          "Set typesZipPath for the app because its types ZIP path could not be read from the config",
        );
      const dependencyHashes: Record<string, string> = Object.create(null);
      const external: [string, string, string][] = [];
      const installedInputs = new Map<string, string>();
      for (const { remote, url, producer } of links) {
        if (url === null || (producer === undefined && !generate)) continue;
        const link: RemoteLink = remoteLink(app.name, remote);
        const resolveTarget = () => dependencyTypesTarget(app, remote, context.apps);
        const destination = resolveTarget();
        const previous = confirmations.install(link) ?? confirmations.installedAt(link);
        const sameRemote = previous?.remoteName === link.remoteName && previous.url === link.url;
        if (producer !== undefined) {
          const zip = zips.get(producer)!;
          const installStarted = Date.now();
          const installed = await installLocalTypesArchive({
            zipPath: zip.zipPath,
            expectedZipHash: zip.zipHash,
            destination,
            appDir: app.folder,
            beforeReplace: resolveTarget,
            confirmedFilesFingerprint:
              sameRemote && previous.zipHash === zip.zipHash
                ? previous.filesFingerprint
                : undefined,
          }).finally(() => {
            phases.installLocalMs += Date.now() - installStarted;
          });
          dependencyHashes[producer] = installed.zipHash;
          installedInputs.set(destination, installed.filesFingerprint);
          if (installed.changed) report.installed.push({ consumer: app.name, alias: remote.alias });
          if (
            installed.changed ||
            !sameRemote ||
            previous.zipHash !== installed.zipHash ||
            previous.filesFingerprint !== installed.filesFingerprint ||
            previous.fromManifest === undefined
          ) {
            confirmations.saveInstall(link, installed.filesFingerprint, installed.zipHash, false);
            dirty = true;
          }
          continue;
        }
        const installStarted = Date.now();
        const evidence = await readInstalledEvidenceAsync(destination, log, true).finally(() => {
          phases.installRemoteMs += Date.now() - installStarted;
        });
        let fingerprint = evidence.filesFingerprint;
        // A missing provenance flag is ambiguous for older installs of same-named producers.
        const needsManifest =
          previous?.fromManifest === false ||
          (previous?.fromManifest === undefined && localNames.has(remote.name));
        if (
          !fingerprint ||
          fingerprint === EMPTY_TYPES_FINGERPRINT ||
          (previous !== null && (!sameRemote || previous.filesFingerprint !== fingerprint)) ||
          needsManifest
        ) {
          const fetchStarted = Date.now();
          const installed = await io
            .installRemoteTypes(
              app,
              remote,
              url.href,
              context.refetchCommand,
              undefined,
              log,
              context.apps,
            )
            .finally(() => {
              phases.installRemoteMs += Date.now() - fetchStarted;
            });
          confirmations.saveInstall(link, installed.filesFingerprint, installed.zipHash, true);
          fingerprint = installed.filesFingerprint;
          report.installed.push({ consumer: app.name, alias: remote.alias });
          dirty = true;
        }
        external.push([remote.alias, url.href, fingerprint]);
        installedInputs.set(destination, fingerprint);
      }
      if (!generate) {
        outcome = report.installed.length > installStart ? "installed" : "current";
        status(outcome);
        continue;
      }
      const fingerprint = (tsconfig: string) =>
        context.fingerprintInputs?.(app, customZipPath, tsconfig, external) ??
        inputsFingerprint(app, context, customZipPath, tsconfig, external);
      const { sources, inputs } = await measured(
        async () => {
          const sources = await sourceIdentityAsync(app.folder, app.tsconfig, app.typesFolder, log);
          const inputs = await fingerprint(sources.tsconfigFingerprint);
          await verifyConfig(app);
          return { sources, inputs };
        },
        (durationMs) => (phases.prepareMs += durationMs),
      );
      let zip: LocalGeneratedZip;
      let localFingerprint: string | null = inputs;
      let current = false;
      const generateStarted = Date.now();
      try {
        if (customZipPath !== null) {
          const before = zipRevision(customZipPath);
          await io.runRebuildCommand(app, command, log);
          zip = await generatedZip(customZipPath, before, app.folder);
        } else {
          const previous =
            app.name === context.target ? undefined : confirmations.generation(app.name);
          const confirmed =
            previous?.local &&
            confirmations.generationConfirmed(
              app.name,
              sources.fingerprint,
              previous.zipHash,
              dependencyHashes,
            )
              ? { ...previous.local, zipHash: previous.zipHash }
              : undefined;
          const environment = app.launchEnvironment ?? {
            envMode: context.envMode,
            ...(app.bundler !== "rslib" && { env: readModeEnv(app.folder, context.envMode) }),
          };
          const result = await io.generateLocalFederatedTypes(
            {
              appDir: app.folder,
              name: app.name,
              configFile: app.buildConfigFile ?? app.configFile,
              ...(app.bundler && { bundler: app.bundler }),
              ...environment,
              workspaceFingerprint: inputs,
              confirmed,
            },
            undefined,
            (timings) => {
              generationTimings = timings;
            },
          );
          const { timings, ...archive } = result;
          generationTimings = timings;
          zip = archive;
          localFingerprint = result.inputsFingerprint;
          current = result.current;
        }
      } finally {
        phases.generateMs += Date.now() - generateStarted;
      }
      await measured(
        async () => {
          const after = await sourceIdentityAsync(app.folder, app.tsconfig, app.typesFolder, log);
          if (
            after.fingerprint !== sources.fingerprint ||
            (await fingerprint(after.tsconfigFingerprint)) !== inputs
          )
            throw new Error(CHANGED_CONFIG);
          for (const [destination, installedFingerprint] of installedInputs) {
            const evidence = await readInstalledEvidenceAsync(destination, log, true);
            if (evidence.filesFingerprint !== installedFingerprint)
              throw new Error("Installed dependency types changed during type generation");
          }
          await verifyConfig(app);
        },
        (durationMs) => (phases.verifyMs += durationMs),
      );
      zips.set(app.name, zip);
      if (current) {
        report.current.push(app.name);
        outcome = "current";
        status("current");
        continue;
      }
      confirmations.saveGeneration(
        app.name,
        sources.fingerprint,
        zip.zipHash,
        dependencyHashes,
        localFingerprint
          ? { zipPath: zip.zipPath, inputsFingerprint: localFingerprint }
          : undefined,
      );
      report.rebuilt.push(app.name);
      outcome = "rebuilt";
      status("rebuilt");
      dirty = true;
    } catch (error) {
      const issue = {
        app: app.name,
        reason: errorMessage(error),
        ...(error instanceof LocatedError && { problems: error.problems }),
      };
      report.failed.push(issue);
      outcome = "failed";
      status("failed", issue);
      log.event("error", "types.rebuild.all.failed", { app: app.name, ...safeError(error) });
    } finally {
      recordApp();
    }
  }
  if (dirty) await context.persist();
  return report;
}

async function measured<T>(work: () => Promise<T>, add: (durationMs: number) => void): Promise<T> {
  const started = Date.now();
  try {
    return await work();
  } finally {
    add(Date.now() - started);
  }
}
