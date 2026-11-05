import { DiagnosticError } from "../../shared/diagnostic-error.ts";
import {
  generateLocalTypesOnDisk,
  type GenerationReply,
  type LocalGenerationInput,
} from "./generate.mts";

process.once("disconnect", () => process.exit(1));
process.once("message", async (input: LocalGenerationInput) => {
  let reply: GenerationReply;
  try {
    Object.assign(process.env, input.env);
    reply = { result: await generateLocalTypesOnDisk(input) };
  } catch (error) {
    reply = {
      error: error instanceof Error ? error.message : String(error),
      details: error instanceof DiagnosticError ? error.details : undefined,
    };
  }
  process.send!(reply, (error) => process.exit(error || "error" in reply ? 1 : 0));
});
