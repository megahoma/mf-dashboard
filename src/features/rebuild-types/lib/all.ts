import path from "node:path";
import {
  EMPTY_TYPES_FINGERPRINT,
  installLocalTypesArchive,
  readInstalledEvidenceAsync,
  sourceIdentityAsync,
} from "../../../entities/federated-types/index.ts";
import { readModeEnv, remoteLink, type RemoteLink } from "../../../entities/microfrontend/index.ts";
import { noLog } from "../../../shared/config/logging.ts";
import { errorMessage } from "../../../shared/lib/errors.ts";
import { safeError } from "../../../shared/lib/logging.ts";
import { dependencyTypesTarget, installRemoteTypes } from "../../refetch-types/index.ts";
import type { RebuildAllContext, RebuildAllReport } from "../models/all.ts";
import type { LocalGeneratedZip } from "../models/generate.ts";
import { runRebuildCommand } from "./command.ts";
import { generateLocalFederatedTypes } from "./generate.mts";
import { generatedZip, zipRevision } from "./generated-zip.ts";
import { inputsFingerprint } from "./inputs-fingerprint.ts";
import { workspaceTypesPlan } from "./workspace-plan.ts";

const operations = { generateLocalFederatedTypes, runRebuildCommand, installRemoteTypes };

export async function rebuildAllTypes(
  context: RebuildAllContext,
  io: typeof operations = operations,
): Promise<RebuildAllReport> {
  const { order, cycles } = workspaceTypesPlan(context.apps);
  const { confirmations } = context;
  const log = context.log ?? noLog;
  const report: RebuildAllReport = {
    rebuilt: [],
    current: [],
    installed: [],
    skipped: [],
    failed: [],
  };
  const localNames = new Set(
    context.apps.filter((app) => app.generateTypes && app.port != null).map((app) => app.name),
  );
  const zips = new Map<string, LocalGeneratedZip>();
  let dirty = false;
  log.event("debug", "types.rebuild.all.plan", { apps: order.length, cycles: cycles.size });
  for (const [index, { app, generate, links, dependencies }] of order.entries()) {
    context.progress?.(app.name, index, order.length);
    const missing = links.find(({ url }) => url === null);
    const blocked = dependencies.find((name) => !zips.has(name));
    const reason =
      cycles.get(app.name) ??
      (missing ? `Unresolved URL for ${missing.remote.alias}` : undefined) ??
      (blocked ? `Dependency ${blocked} could not be updated` : undefined);
    if (reason !== undefined) {
      report.skipped.push({ app: app.name, reason });
      log.event("warn", "types.rebuild.all.skipped", { app: app.name, reason });
      continue;
    }
    try {
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
        const evidence = await readInstalledEvidenceAsync(destination, log, true);
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
          const installed = await io.installRemoteTypes(
            app,
            remote,
            url.href,
            context.refetchCommand,
            undefined,
            log,
            context.apps,
          );
          confirmations.saveInstall(link, installed.filesFingerprint, installed.zipHash, true);
          fingerprint = installed.filesFingerprint;
          report.installed.push({ consumer: app.name, alias: remote.alias });
          dirty = true;
        }
        external.push([remote.alias, url.href, fingerprint]);
        installedInputs.set(destination, fingerprint);
      }
      if (!generate) continue;
      const sources = await sourceIdentityAsync(app.folder, app.tsconfig, app.typesFolder, log);
      const inputs = await inputsFingerprint(
        app,
        context,
        customZipPath,
        sources.tsconfigFingerprint,
        external,
      );
      let zip: LocalGeneratedZip;
      let localFingerprint: string | null = inputs;
      let current = false;
      if (customZipPath !== null) {
        const before = zipRevision(customZipPath);
        await io.runRebuildCommand(app, command, log);
        zip = await generatedZip(customZipPath, before, app.folder);
      } else {
        const previous = confirmations.generation(app.name);
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
          env: readModeEnv(app.folder, context.envMode),
        };
        const result = await io.generateLocalFederatedTypes({
          appDir: app.folder,
          name: app.name,
          configFile: app.buildConfigFile ?? app.configFile,
          ...environment,
          workspaceFingerprint: inputs,
          confirmed,
        });
        zip = result;
        localFingerprint = result.inputsFingerprint;
        current = result.current;
      }
      const after = await sourceIdentityAsync(app.folder, app.tsconfig, app.typesFolder, log);
      if (
        after.fingerprint !== sources.fingerprint ||
        (await inputsFingerprint(
          app,
          context,
          customZipPath,
          after.tsconfigFingerprint,
          external,
        )) !== inputs
      )
        throw new Error("Sources or build configuration changed during type generation");
      for (const [destination, fingerprint] of installedInputs) {
        const evidence = await readInstalledEvidenceAsync(destination, log, true);
        if (evidence.filesFingerprint !== fingerprint)
          throw new Error("Installed dependency types changed during type generation");
      }
      zips.set(app.name, zip);
      if (current) {
        report.current.push(app.name);
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
      dirty = true;
    } catch (error) {
      report.failed.push({
        app: app.name,
        reason: errorMessage(error),
      });
      log.event("error", "types.rebuild.all.failed", { app: app.name, ...safeError(error) });
    }
  }
  if (dirty) await context.persist();
  return report;
}
