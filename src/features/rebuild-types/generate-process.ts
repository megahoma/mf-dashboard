import { errorMessage } from "../../shared/lib/errors.ts";
import { DiagnosticError } from "../../shared/models/diagnostic-error.ts";
import { generateTypesOnDisk } from "./lib/generate-on-disk.ts";
import type { GenerationReply, GenerationRequest } from "./models/generate.ts";

process.once("disconnect", () => process.exit(1));

process.once("message", async (input: GenerationRequest) => {
  let reply: GenerationReply;
  try {
    if (input.env) Object.assign(process.env, input.env);
    reply = { result: await generateTypesOnDisk(input) };
  } catch (error) {
    reply = {
      error: errorMessage(error),
      details: error instanceof DiagnosticError ? error.details : undefined,
    };
  }
  process.send!(reply, (error) => process.exit(error || "error" in reply ? 1 : 0));
});
