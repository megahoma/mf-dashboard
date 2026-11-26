import { realpathSync } from "node:fs";
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
import { DiagnosticError } from "../../../shared/models/diagnostic-error.ts";
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

function manifestUnavailable(error: unknown): boolean {
  if (!(error instanceof DiagnosticError) || error.details.stage !== "manifest") return false;
  const { reason, status } = error.details;
  return (
    reason === "network" ||
    reason === "timeout" ||
    reason === "invalid-json" ||
    reason === "missing-types-metadata" ||
    (reason === "http-status" && status !== undefined && (status === 404 || status >= 500))
  );
}

export async function rebuildAllTypes(
  context: RebuildAllContext,
  io: typeof operations = operations,
): Promise<RebuildAllReport> {
  const planStarted = Date.now();
  const { order, candidates, cycles, conflicts, apps } = workspaceTypesPlan(
    context.apps,
    context.target,
  );
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
  const reportedConflicts = new Set<string>();
  const reportConflict = (name: string) => {
    const duplicates = conflicts.get(name);
    if (!duplicates || reportedConflicts.has(name)) return;
    reportedConflicts.add(name);
    const updates = duplicates.map((app) => ({
      app: name,
      settingsKey: app.settingsKey ?? app.folder,
      status: "skipped" as const,
      reason: `Duplicate Module Federation name: ${name} (${app.configFile})`,
    }));
    report.skipped.push(
      ...updates.map(({ settingsKey, reason }) => ({ app: settingsKey, reason })),
    );
    context.status?.(updates);
  };
  for (const { name } of apps) reportConflict(name);
  const localNames = new Set(
    context.apps.filter((app) => app.generateTypes && app.port != null).map((app) => app.name),
  );
  const zips = new Map<string, LocalGeneratedZip>();
  const configSnapshots = new Map<LocalApp, string>();
  const configErrors = new Map<LocalApp, unknown>();
  for (const { app } of candidates.values()) {
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
  const concurrency = buildConcurrency(context, order);
  log.event("info", "types.rebuild.all.plan", {
    apps: order.length,
    cycles: cycles.size,
    conflicts: reportedConflicts.size,
    durationMs: Date.now() - planStarted,
    target: context.target,
    concurrency,
    useBuildCache: context.useBuildCache !== false,
  });
  const started = new Set<string>();
  let nextIndex = 0;
  async function build(name: string): Promise<void> {
    // An active ancestor has no ZIP yet. Treat that edge as unavailable without waiting on it.
    if (started.has(name)) return;
    started.add(name);
    const node = candidates.get(name);
    if (!node) {
      reportConflict(name);
      return;
    }
    const { app, dependencies } = node;
    if (!planned.has(name)) {
      planned.add(name);
      context.status?.([{ app: name, settingsKey: app.settingsKey, status: "queued" }]);
    }
    if (!cycles.has(name)) for (const dependency of dependencies) await build(dependency);
    await buildReady(node);
  }

  async function buildReady(
    node: (typeof order)[number],
    parallel = false,
    retry?: { index: number; installedAliases: string[] },
  ): Promise<{ index: number; installedAliases: string[] } | void> {
    const { app, generate, links, dependencies } = node;
    const index = retry?.index ?? nextIndex++;
    const total = planned.size;
    const installedAliases = retry?.installedAliases ?? [];
    if (!retry) context.progress?.(app.name, index, total);
    const status = (
      state: RebuildAppStatus["status"],
      details?: Pick<RebuildAppStatus, "reason" | "problems" | "builtAt">,
    ) => {
      if (!context.status) return;
      context.status([
        {
          ...details,
          app: app.name,
          settingsKey: app.settingsKey,
          status: state,
          installed: [...installedAliases],
        },
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
    let outcome: RebuildAppStatus["status"] | undefined = "failed";
    let generationTimings: GenerationTimings | undefined;
    const recordApp = () => {
      log.event("info", "types.rebuild.all.app", {
        app: app.name,
        status: outcome,
        index: index + 1,
        total,
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
    const missing = links.find(({ url, producer }) => url === null && producer === undefined);
    const blocked = dependencies.find((name) => !zips.has(name));
    const reason =
      cycles.get(app.name) ??
      (missing ? `Unresolved URL for ${missing.remote.alias}` : undefined) ??
      (blocked ? `Dependency ${blocked} could not be updated` : undefined);
    if (reason !== undefined) {
      report.skipped.push({ app: app.name, reason });
      status("skipped", { reason });
      log.event("warn", "types.rebuild.all.skipped", { app: app.name, reason });
      outcome = "skipped";
      recordApp();
      return;
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
      const dependencyInputs: [string, string, string][] = [];
      const installedInputs = new Map<string, string>();
      for (const { remote, url, producer, fallback } of links) {
        if (producer === undefined && !generate) continue;
        const link: RemoteLink = remoteLink(app.name, remote);
        const resolveTarget = () => dependencyTypesTarget(app, remote, context.apps);
        const destination = resolveTarget();
        const previous = confirmations.install(link) ?? confirmations.installedAt(link);
        const sameRemote = previous?.remoteName === link.remoteName && previous.url === link.url;
        const recordInstall = () => {
          report.installed.push({ consumer: app.name, alias: remote.alias });
          installedAliases.push(remote.alias);
        };
        const installLocal = async (name: string, zip: LocalGeneratedZip) => {
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
            context.typesDirectoryChanged?.(app.name, remote.alias);
          });
          dependencyHashes[name] = installed.zipHash;
          // ZIP timestamps can change without changing the installed compiler inputs.
          dependencyInputs.push([remote.alias, "", installed.filesFingerprint]);
          installedInputs.set(destination, installed.filesFingerprint);
          if (installed.changed) recordInstall();
          if (
            installed.changed ||
            !sameRemote ||
            previous.zipHash !== installed.zipHash ||
            previous.filesFingerprint !== installed.filesFingerprint ||
            previous.fromManifest !== false
          ) {
            confirmations.saveInstall(link, installed.filesFingerprint, installed.zipHash, false);
            dirty = true;
          }
        };
        if (producer !== undefined) {
          await installLocal(producer, zips.get(producer)!);
          continue;
        }
        if (url === null) continue;
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
              context.typesDirectoryChanged?.(app.name, remote.alias);
            })
            .catch(async (error: unknown) => {
              if (fallback === undefined || !manifestUnavailable(error)) throw error;
              await build(fallback);
              const zip = zips.get(fallback);
              if (!zip) throw error;
              await installLocal(fallback, zip);
              log.event("warn", "types.rebuild.all.local-fallback", {
                app: app.name,
                alias: remote.alias,
                producer: fallback,
              });
              return undefined;
            });
          if (!installed) continue;
          confirmations.saveInstall(link, installed.filesFingerprint, installed.zipHash, true);
          fingerprint = installed.filesFingerprint;
          recordInstall();
          dirty = true;
        }
        dependencyInputs.push([remote.alias, url.href, fingerprint]);
        installedInputs.set(destination, fingerprint);
      }
      if (!generate) {
        outcome = installedAliases.length ? "installed" : "current";
        status(outcome);
        return;
      }
      const fingerprint = (tsconfig: string) =>
        context.fingerprintInputs?.(app, customZipPath, tsconfig, dependencyInputs) ??
        inputsFingerprint(app, context, customZipPath, tsconfig, dependencyInputs);
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
      const previous =
        customZipPath === null && context.useBuildCache !== false && app.name !== context.target
          ? confirmations.generation(app.name)
          : undefined;
      const generateStarted = Date.now();
      try {
        if (customZipPath !== null) {
          const before = zipRevision(customZipPath);
          await io.runRebuildCommand(app, command, log);
          zip = await generatedZip(customZipPath, before, app.folder);
        } else {
          const confirmed =
            previous?.local && previous.sourceFingerprint === sources.fingerprint
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
              ...(parallel && { parallel }),
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
        context.typesDirectoryChanged?.(app.name);
      }
      const builtAt = current ? previous?.builtAt : Date.now();
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
      if (
        !current ||
        !confirmations.generationConfirmed(
          app.name,
          sources.fingerprint,
          zip.zipHash,
          dependencyHashes,
        )
      ) {
        confirmations.saveGeneration(
          app.name,
          sources.fingerprint,
          zip.zipHash,
          dependencyHashes,
          localFingerprint
            ? { zipPath: zip.zipPath, inputsFingerprint: localFingerprint }
            : undefined,
          builtAt,
        );
        dirty = true;
      }
      if (current) {
        report.current.push(app.name);
        outcome = "cached";
        status("cached", { builtAt });
        return;
      }
      report.rebuilt.push(app.name);
      outcome = "rebuilt";
      status("rebuilt", { builtAt });
    } catch (error) {
      if (
        parallel &&
        error instanceof DiagnosticError &&
        error.details.reason === "parallel-output"
      ) {
        log.event("debug", "types.rebuild.all.exclusive", { app: app.name });
        status("queued");
        outcome = undefined;
        return { index, installedAliases };
      }
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
      if (outcome) recordApp();
    }
  }
  if (concurrency === 1) {
    for (const { app } of order) await build(app.name);
  } else {
    const run = buildQueue(concurrency);
    const builds = new Map<string, Promise<void>>();
    for (const node of order) {
      const dependencies = cycles.has(node.app.name) ? [] : node.dependencies;
      const ready = Promise.all(dependencies.map((name) => builds.get(name)));
      const result = ready.then(async () => {
        const retry = await run(() => buildReady(node, true));
        if (retry) await run(() => buildReady(node, false, retry), concurrency);
      });
      builds.set(node.app.name, result);
    }
    const results = await Promise.allSettled(builds.values());
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }
  if (dirty) await context.persist();
  return report;
}

function buildConcurrency(
  context: RebuildAllContext,
  order: ReturnType<typeof workspaceTypesPlan>["order"],
): number {
  const limit = context.buildConcurrency ?? 1;
  // Shell commands can write outside their app, and a manifest fallback can introduce another dependency.
  if (
    !Number.isSafeInteger(limit) ||
    limit <= 1 ||
    context.rebuildCommand.trim() ||
    context.refetchCommand.trim() ||
    order.some(({ links }) => links.some(({ fallback }) => fallback !== undefined))
  )
    return 1;
  try {
    const roots = order
      .map(({ app }) => {
        const folder = realpathSync.native(app.folder);
        const key = process.platform === "linux" ? folder : folder.toLowerCase();
        return key.endsWith(path.sep) ? key : key + path.sep;
      })
      .sort();
    if (roots.some((root, index) => index > 0 && root.startsWith(roots[index - 1]))) return 1;
  } catch {
    return 1;
  }
  return Math.max(1, Math.min(limit, order.length));
}

function buildQueue(limit: number) {
  let used = 0;
  const waiting: { slots: number; start(): void }[] = [];
  const drain = () => {
    while (waiting[0] && used + waiting[0].slots <= limit) {
      const { slots, start } = waiting.shift()!;
      used += slots;
      start();
    }
  };
  return <T>(work: () => Promise<T>, slots = 1): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      waiting.push({
        slots,
        start: () => {
          void work()
            .then(resolve, reject)
            .finally(() => {
              used -= slots;
              drain();
            });
        },
      });
      drain();
    });
}

async function measured<T>(work: () => Promise<T>, add: (durationMs: number) => void): Promise<T> {
  const started = Date.now();
  try {
    return await work();
  } finally {
    add(Date.now() - started);
  }
}
