import { performance } from "node:perf_hooks";
import { errorMessage } from "../../shared/lib/errors.ts";
import { DiagnosticError } from "../../shared/models/diagnostic-error.ts";
import { LocatedError } from "../../shared/models/source-problem.ts";
import { observeSdkWorker } from "./lib/compiler-problems.mts";
import { generateTypesOnDisk } from "./lib/generate-on-disk.ts";
import {
  emptyGenerationPhaseTimings,
  type GenerationMessage,
  type GenerationReply,
  type GenerationRequest,
  type MeasureGenerationPhase,
} from "./models/generate.ts";

async function generate(input: GenerationRequest) {
  process.setSourceMapsEnabled(true);
  const timings = emptyGenerationPhaseTimings();
  const progress = (activePhase?: keyof typeof timings) => {
    process.send!(
      {
        kind: "mf-dashboard.generation-progress",
        timings,
        activePhase,
      } satisfies GenerationMessage,
      () => {},
    );
  };
  const measure: MeasureGenerationPhase = async (phase, work) => {
    const startedAt = performance.now();
    progress(phase);
    try {
      return await work();
    } finally {
      timings[phase] += Math.round(performance.now() - startedAt);
      progress();
    }
  };
  let reply: GenerationReply;
  try {
    // Rslib resolves the fixed dotenv helper before applying project environment variables.
    if (input.bundler !== "rslib" && input.env) Object.assign(process.env, input.env);
    reply = {
      kind: "mf-dashboard.generation-reply",
      result: await generateTypesOnDisk(input, measure),
      timings,
    };
  } catch (error) {
    reply = {
      kind: "mf-dashboard.generation-reply",
      error: errorMessage(error),
      details: error instanceof DiagnosticError ? error.details : undefined,
      problems: error instanceof LocatedError ? error.problems : undefined,
      timings,
    };
  }
  process.send!(reply, (error) => process.exit(error || "error" in reply ? 1 : 0));
}

if (!observeSdkWorker()) {
  process.once("disconnect", () => process.exit(1));
  process.once("message", generate);
}
