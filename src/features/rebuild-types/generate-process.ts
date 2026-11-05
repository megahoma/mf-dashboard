import { DiagnosticError } from "../../shared/diagnostic-error.ts";
import { generateTypesOnDisk, type GenerationReply, type GenerationRequest } from "./generate.mts";

process.once("disconnect", () => process.exit(1));
process.once("message", async (input: GenerationRequest) => {
  let reply: GenerationReply;
  try {
    if ("env" in input) Object.assign(process.env, input.env);
    reply = { result: await generateTypesOnDisk(input) };
  } catch (error) {
    reply = {
      error: error instanceof Error ? error.message : String(error),
      details: error instanceof DiagnosticError ? error.details : undefined,
    };
  }
  process.send!(reply, (error) => process.exit(error || "error" in reply ? 1 : 0));
});
