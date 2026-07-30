import { ZodError } from "zod";
import { validateAndDedupeExtraction } from "@/lib/domain/extraction-schema";
import type { ExtractionResult } from "@/lib/domain/types";
import { TaskExtractionError } from "./task-extraction";

export async function extractWithRepair(
  request: (repairMessage?: string) => Promise<unknown>,
): Promise<ExtractionResult> {
  try {
    return validateAndDedupeExtraction(await request());
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    try {
      const repairMessage = `The previous result failed validation. Correct these errors without adding facts: ${JSON.stringify(error.issues)}`;
      return validateAndDedupeExtraction(await request(repairMessage));
    } catch (repairError) {
      throw new TaskExtractionError(
        "INVALID_PROVIDER_OUTPUT",
        "The extracted tasks could not be validated after one repair attempt. Your pasted text is still safe to retry.",
        { cause: repairError },
      );
    }
  }
}

