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
import {
  TaskExtractionError,
  type TaskExtractionProvider,
} from "./task-extraction";
import { extractWithRepair } from "./validated-extraction";

const SYSTEM_INSTRUCTIONS = `You extract planning responsibilities into structured data.

Non-negotiable rules:
- Never invent a deadline, due time, fixed time, or recurrence rule.
- Use the supplied IANA time zone and current local date for relative dates.
- Recognize an explicit date anywhere in a responsibility, including when it appears directly after the task without words such as "by" or "due". For example, "Submit lab report 8/15/2026" is a flexible task due on 2026-08-15.
- Resolve ISO, numeric, and month-name dates. Treat ambiguous numeric formats such as 8/9 as month/day, lower confidence, add a clarification to missingInformation, and mark reviewRequired.
- Preserve the exact relevant source text.
- Separate flexible work, fixed-time events, finite recurring goals, and ignored informational statements.
- Do not turn every line into a task. Ignore headings, greetings, signatures, email headers, standalone links or dates, random fragments, status updates, and background text with no concrete user action.
- A reminder, note, or FYI is a task only when it contains a concrete action for the user. "Reminder: submit timesheet Friday" is a task; "Reminder: office closed Friday" is ignored.
- "Chemistry exam — Aug 15" is a dated responsibility. "FYI: library entrance moved" is ignored.
- A date without a time must keep dueTime absent.
- Use fixed_time only for an occurrence at a scheduled time. A deadline remains flexible even when it includes a due time.
- A fixed event without an end time may leave fixedEndAt absent and must name that missing information.
- Estimate effort conservatively and lower field confidence when it is inferred.
- Do not assume work is splittable unless the wording or task shape supports it.
- Mark reviewRequired when a critical field is uncertain.
- Return no prose outside the schema.`;

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
    this.model = process.env.OPENAI_MODEL ?? "gpt-5.6";
  }

  private async request(
    input: ExtractionInput,
    repairMessage?: string,
  ): Promise<unknown> {
    const response = await this.client.responses.parse({
      model: this.model,
      instructions: SYSTEM_INSTRUCTIONS,
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
