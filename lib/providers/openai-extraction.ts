import "server-only";

import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import {
  extractionResultSchema,
} from "@/lib/domain/extraction-schema";
import type {
  ExtractionInput,
  ExtractionResult,
} from "@/lib/domain/types";
import { EXTRACTION_INSTRUCTIONS } from "./extraction-instructions";
import {
  TaskExtractionError,
  type TaskExtractionProvider,
} from "./task-extraction";
import { extractWithRepair } from "./validated-extraction";

export class OpenAITaskExtractionProvider
  implements TaskExtractionProvider
{
  private readonly client: OpenAI;
  private readonly model: string;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new TaskExtractionError(
        "PROVIDER_UNAVAILABLE",
        "OpenAI extraction is not configured. Use mock mode or add OPENAI_API_KEY.",
      );
    }
    this.client = new OpenAI({ apiKey });
    this.model = process.env.OPENAI_MODEL ?? "gpt-5.6-sol";
  }

  private async request(
    input: ExtractionInput,
    repairMessage?: string,
  ): Promise<unknown> {
    const response = await this.client.responses.parse({
      model: this.model,
      instructions: EXTRACTION_INSTRUCTIONS,
      input: [
        {
          role: "user",
          content: [
            `Current local date: ${input.currentLocalDate}`,
            `IANA time zone: ${input.timeZone}`,
            repairMessage ? `Repair request: ${repairMessage}` : "",
            "Source content:",
            input.text,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
      text: {
        format: zodTextFormat(extractionResultSchema, "task_extraction"),
      },
    });
    if (!response.output_parsed) {
      throw new TaskExtractionError(
        "INVALID_PROVIDER_OUTPUT",
        "The extraction provider returned no structured result.",
      );
    }
    return response.output_parsed;
  }

  async extractTasks(input: ExtractionInput): Promise<ExtractionResult> {
    try {
      return await extractWithRepair((repairMessage) =>
        this.request(input, repairMessage),
      );
    } catch (error) {
      if (error instanceof TaskExtractionError) throw error;
      throw new TaskExtractionError(
        "PROVIDER_UNAVAILABLE",
        "Task extraction is temporarily unavailable.",
        { cause: error },
      );
    }
  }
}
