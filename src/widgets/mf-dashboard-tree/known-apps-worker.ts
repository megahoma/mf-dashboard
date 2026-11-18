import { parentPort } from "node:worker_threads";
import { prepareWorkspaceScan } from "../../entities/microfrontend/index.ts";
import { inputsFingerprint, rebuildConfigFingerprint } from "../../features/rebuild-types/index.ts";
import { errorMessage } from "../../shared/lib/errors.ts";
import { noLog } from "../../shared/config/logging.ts";
import { resolveLogFields } from "../../shared/lib/logging.ts";
import type { LogContext } from "../../shared/models/logging.ts";
import { createAppParseCache, withDiscoveryCache } from "./lib/app-parse-cache.ts";
import { planDiscovery, prepareDiscoverySnapshot } from "./lib/discovery.ts";
import { loadKnownApps } from "./lib/known-apps.ts";
import { resolveRebuildApps } from "./lib/rebuild-apps.ts";
import type { ConfigWorkerReply, ConfigWorkerTask } from "./models/session-types.ts";

let activeLog = noLog;
const cache = createAppParseCache({
  operation: (source) => activeLog.operation(source),
  event: (...args) => activeLog.event(...args),
});

function perform(task: ConfigWorkerTask, log: LogContext) {
  const { kind, input } = task;
  switch (kind) {
    case "prepare":
      return prepareDiscoverySnapshot(input.roots, input.settings, prepareWorkspaceScan, log);
    case "discover":
      return planDiscovery(input.roots, input.settings, input.previous, prepareWorkspaceScan, log);
    case "rebuild":
      return resolveRebuildApps(input.roots, input.settings, log);
    case "fingerprint":
      return inputsFingerprint(...input);
    case "rebuildConfigStamp":
      return rebuildConfigFingerprint(input);
    case "load": {
      const { roots, settings, discovery } = input;
      const ownershipSources = new Set<string>();
      const apps = loadKnownApps(
        roots,
        settings.apps ?? {},
        settings.envMode,
        settings.ignorePaths,
        withDiscoveryCache(cache, discovery),
        log,
        settings.startScript,
        ownershipSources,
      );
      return { apps, ownershipSources };
    }
  }
}

parentPort!.on("message", (task: ConfigWorkerTask) => {
  const events: ConfigWorkerReply["events"] = [];
  const log: LogContext = {
    operation: () => log,
    event(level, event, fields) {
      if (task.logLevels.includes(level))
        events.push({ level, event, fields: resolveLogFields(fields) });
    },
  };
  activeLog = log;
  try {
    parentPort!.postMessage({
      events,
      result: perform(task, log),
    } satisfies ConfigWorkerReply);
  } catch (error) {
    parentPort!.postMessage({ events, error: errorMessage(error) } satisfies ConfigWorkerReply);
  } finally {
    activeLog = noLog;
  }
});
