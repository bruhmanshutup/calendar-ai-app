import "server-only";

import type {
  ExtractionInput,
  ExtractionResult,
} from "@/lib/domain/types";
import { EXTRACTION_INSTRUCTIONS } from "./extraction-instructions";
import { GEMINI_EXTRACTION_SCHEMA } from "./gemini-extraction-schema";
import {
  TaskExtractionError,
  type TaskExtractionProvider,
} from "./task-extraction";
import { extractWithRepair } from "./validated-extraction";

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
};

export class GeminiTaskExtractionProvider
  implements TaskExtractionProvider
{
  private readonly apiKey: string;
  private readonly model: string;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new TaskExtractionError(
        "PROVIDER_UNAVAILABLE",
        "Gemini extraction is not configured. Add GEMINI_API_KEY or use local mode.",
      );
    }
    this.apiKey = apiKey;
    this.model = (process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite").replace(
      /^models\//,
      "",
    );
  }

  private async request(
    input: ExtractionInput,
    repairMessage?: string,
  ): Promise<unknown> {
    const prompt = [
      EXTRACTION_INSTRUCTIONS,
      `Current local date: ${input.currentLocalDate}`,
      `IANA time zone: ${input.timeZone}`,
      repairMessage ? `Repair request: ${repairMessage}` : "",
      `Required JSON schema: ${JSON.stringify(GEMINI_EXTRACTION_SCHEMA)}`,
      input.structureHint ?? "",
      "Source content:",
      input.text,
    ]
      .filter(Boolean)
      .join("\n");
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: "POST",
        signal: AbortSignal.timeout(20_000),
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 32_768,
            responseMimeType: "application/json",
          },
        }),
      },
    );
    if (!response.ok) {
      const errorPayload = (await response.json().catch(() => undefined)) as
        | { error?: { message?: string } }
        | undefined;
      const testDetail =
        process.env.NODE_ENV === "test" && errorPayload?.error
          ? ` ${JSON.stringify(errorPayload.error)}`
          : "";
      throw new TaskExtractionError(
        "PROVIDER_UNAVAILABLE",
        response.status === 429
          ? `Gemini's request limit was reached. Try again shortly.${testDetail}`
          : `Gemini extraction is temporarily unavailable.${testDetail}`,
      );
    }
    const payload = (await response.json()) as GeminiResponse;
    const text = payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("")
      .trim();
    if (!text) {
      throw new TaskExtractionError(
        "INVALID_PROVIDER_OUTPUT",
        "Gemini returned no structured result.",
      );
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new TaskExtractionError(
        "INVALID_PROVIDER_OUTPUT",
        "Gemini returned malformed structured data.",
        { cause: error },
      );
    }
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
        "Gemini extraction is temporarily unavailable.",
        { cause: error },
      );
    }
  }
}
