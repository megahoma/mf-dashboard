import { errorMessage } from "../../shared/lib/errors.ts";
import { DiagnosticError } from "../../shared/models/diagnostic-error.ts";
import { LocatedError } from "../../shared/models/source-problem.ts";
import { observeSdkWorker } from "./lib/compiler-problems.mts";
import { generateTypesOnDisk } from "./lib/generate-on-disk.ts";
import type { GenerationReply, GenerationRequest } from "./models/generate.ts";

async function generate(input: GenerationRequest) {
  process.setSourceMapsEnabled(true);
  let reply: GenerationReply;
  try {
    // Rslib resolves the fixed dotenv helper before applying project environment variables.
    if (input.bundler !== "rslib" && input.env) Object.assign(process.env, input.env);
    reply = { result: await generateTypesOnDisk(input) };
  } catch (error) {
    reply = {
      error: errorMessage(error),
      details: error instanceof DiagnosticError ? error.details : undefined,
      problems: error instanceof LocatedError ? error.problems : undefined,
    };
  }
  process.send!(reply, (error) => process.exit(error || "error" in reply ? 1 : 0));
}

if (!observeSdkWorker()) {
  process.once("disconnect", () => process.exit(1));
  process.once("message", generate);
}
