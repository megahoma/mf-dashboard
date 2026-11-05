import { parentPort } from "node:worker_threads";
import { DiagnosticError } from "../../shared/diagnostic-error.ts";
import type { LogContext } from "../../shared/logging.ts";
import { sourceContains, sourceIdentity } from "./sources.ts";
import { readInstalledEvidence } from "./observe.ts";
import { fingerprintArchiveBytes } from "./install.ts";
import type { EvidenceReply, EvidenceTask } from "./evidence-worker-client.mts";

parentPort!.on("message", async (task: EvidenceTask) => {
  const reply: EvidenceReply = { events: [] };
  const log: LogContext = {
    operation() {
      return log;
    },
    event(level, event, fields) {
      reply.events.push({ level, event, fields: typeof fields === "function" ? fields() : fields });
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
      message: error instanceof Error ? error.message : String(error),
      code:
        error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : undefined,
      details: error instanceof DiagnosticError ? error.details : undefined,
    };
  }
  parentPort!.postMessage(reply);
});
