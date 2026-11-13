import { parentPort } from "node:worker_threads";
import { errorMessage } from "../../shared/lib/errors.ts";
import { resolveLogFields } from "../../shared/lib/logging.ts";
import { DiagnosticError } from "../../shared/models/diagnostic-error.ts";
import type { LogContext } from "../../shared/models/logging.ts";
import { fingerprintArchiveBytes } from "./lib/archive.ts";
import { readInstalledEvidence } from "./lib/observe.ts";
import { sourceContains, sourceIdentity } from "./lib/sources.ts";
import type { EvidenceReply, EvidenceTask } from "./models/evidence-worker-client.ts";

parentPort!.on("message", async (task: EvidenceTask) => {
  const reply: EvidenceReply = { events: [] };
  const log: LogContext = {
    operation() {
      return log;
    },
    event(level, event, fields) {
      reply.events.push({ level, event, fields: resolveLogFields(fields) });
    },
  };
  try {
    switch (task.kind) {
      case "sources":
        reply.value = sourceIdentity(task.folder, task.tsconfig, task.typesFolder, log);
        break;
      case "contains":
        reply.value = sourceContains(task.folder, task.tsconfig, task.typesFolder, task.file);
        break;
      case "installed":
        reply.value = readInstalledEvidence(task.destination, log, task.fresh);
        break;
      case "archive":
        reply.value = await fingerprintArchiveBytes(task.bytes, task.appDir);
        break;
    }
  } catch (error) {
    reply.error = {
      message: errorMessage(error),
      code:
        error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : undefined,
      details: error instanceof DiagnosticError ? error.details : undefined,
    };
  }
  parentPort!.postMessage(reply);
});
