import "server-only";
import { globalInstructionPrompt } from "@/lib/domain/global-instructions";

import { addDays, format, parseISO } from "date-fns";
import { ZodError } from "zod";

import { resolveRelativeDate } from "@/lib/domain/date-interpretation";
import { validateAndDedupeExtraction } from "@/lib/domain/extraction-schema";
import type {
  ExtractionInput,
  ExtractionResult,
} from "@/lib/domain/types";
import { SEMANTIC_DRAFT_INSTRUCTIONS } from "./semantic-draft-instructions";
import {
  GEMINI_SEMANTIC_DRAFT_SCHEMA,
  semanticDraftSchema,
  type SemanticDraft,
} from "./semantic-draft";
import { normalizeSemanticDraftProviderOutput } from "./semantic-draft-provider-normalization";
import { compileSemanticDraft } from "./semantic-draft-compiler";
import {
  TaskExtractionError,
  type TaskExtractionProvider,
} from "./task-extraction";

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  modelVersion?: string;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
    serviceTier?: string;
  };
};

type GeminiThinkingLevel = "minimal" | "low" | "medium" | "high";

type GeminiGenerationSettings = {
  temperature?: number;
  thinkingLevel?: GeminiThinkingLevel;
};

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function occurrenceDateFromSource(
  sourceText: string,
  input: ExtractionInput,
): string | undefined {
  if (/\b(?:the\s+)?day\s+after\s+tomorrow\b/i.test(sourceText)) {
    return format(addDays(parseISO(input.currentLocalDate), 2), "yyyy-MM-dd");
  }
  const expression = sourceText.match(
    /\b(today|tomorrow|(?:(?:next|this)\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i,
  )?.[1];
  if (!expression) return undefined;
  const resolved = resolveRelativeDate(
    expression,
    input.currentLocalDate,
    input.timeZone,
  );
  return resolved.ambiguous ? undefined : resolved.date;
}

function repairMissingOccurrenceDates(
  value: unknown,
  input: ExtractionInput,
): unknown {
  const root = objectValue(value);
  if (!root || !Array.isArray(root.responsibilities)) return value;
  root.responsibilities.forEach((item) => {
    const responsibility = objectValue(item);
    const occurrence = objectValue(responsibility?.occurrence);
    if (!responsibility || !occurrence || typeof occurrence.date === "string") {
      return;
    }
    const deadline = objectValue(responsibility.deadline);
    const sourceText =
      typeof responsibility.sourceText === "string"
        ? responsibility.sourceText
        : "";
    const date =
      (typeof deadline?.date === "string" ? deadline.date : undefined) ??
      occurrenceDateFromSource(sourceText, input);
    if (date) {
      occurrence.date = date;
    } else if (responsibility.kind === "task") {
      delete responsibility.occurrence;
    }
  });
  return root;
}

const PROVIDER_TIMEOUT_MS = 45_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function optionalTemperature(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
    throw new TaskExtractionError(
      "PROVIDER_UNAVAILABLE",
      "GEMINI_TEMPERATURE must be a number from 0 through 2, or left unset to use the model default.",
    );
  }
  return parsed;
}

function optionalThinkingLevel(
  value: string | undefined,
): GeminiThinkingLevel | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const normalized = value.trim().toLowerCase();
  if (
    normalized !== "minimal" &&
    normalized !== "low" &&
    normalized !== "medium" &&
    normalized !== "high"
  ) {
    throw new TaskExtractionError(
      "PROVIDER_UNAVAILABLE",
      "GEMINI_THINKING_LEVEL must be minimal, low, medium, high, or left unset to use the model default.",
    );
  }
  return normalized;
}

export function resolveGeminiGenerationSettings(
  environment: Record<string, string | undefined> = process.env,
): GeminiGenerationSettings {
  const temperature = optionalTemperature(environment.GEMINI_TEMPERATURE);
  const thinkingLevel = optionalThinkingLevel(
    environment.GEMINI_THINKING_LEVEL,
  );
  return {
    ...(temperature === undefined ? {} : { temperature }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  };
}

function generationConfig(
  settings: GeminiGenerationSettings,
  maxOutputTokens: number,
  responseJsonSchema?: unknown,
): Record<string, unknown> {
  return {
    maxOutputTokens,
    responseMimeType: "application/json",
    ...(responseJsonSchema ? { responseJsonSchema } : {}),
    ...(settings.temperature === undefined
      ? {}
      : { temperature: settings.temperature }),
    ...(settings.thinkingLevel
      ? { thinkingConfig: { thinkingLevel: settings.thinkingLevel } }
      : {}),
  };
}

function logUsage(
  stage: "discovery" | "semantic",
  input: ExtractionInput,
  payload: GeminiResponse,
  durationMs: number,
): void {
  if (process.env.GEMINI_LOG_USAGE !== "1") return;
  console.log(
    `[gemini-usage] ${JSON.stringify({
      stage,
      sourceId: input.sourceId,
      modelVersion: payload.modelVersion,
      durationMs,
      ...payload.usageMetadata,
    })}`,
  );
}

function logValidationIssues(stage: string, error: ZodError): void {
  if (process.env.GEMINI_LOG_USAGE !== "1") return;
  console.warn(
    `[gemini-validation] ${JSON.stringify({
      stage,
      issues: error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    })}`,
  );
}

function retryAfterMs(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return 750 * 2 ** attempt;
}

async function fetchWithTransientRetry(
  url: string,
  init: Omit<RequestInit, "signal">,
  timeoutMs: number,
): Promise<Response> {
  const deadline = Date.now() + Math.max(1_000, timeoutMs);
  let lastResponse: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining < 1_000) break;
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(remaining),
      });
      lastResponse = response;
      if (!RETRYABLE_STATUS.has(response.status) || attempt === 2) {
        return response;
      }
      const delay = Math.min(retryAfterMs(response, attempt), 5_000);
      if (deadline - Date.now() <= delay + 1_000) return response;
      await new Promise((resolve) => setTimeout(resolve, delay));
    } catch (error) {
      if (attempt === 2 || deadline - Date.now() < 2_000) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
  if (lastResponse) return lastResponse;
  throw new TaskExtractionError(
    "PROVIDER_UNAVAILABLE",
    "Gemini extraction timed out before a response was available.",
    { fallbackReason: "request_timed_out" },
  );
}

export class GeminiTaskExtractionProvider
  implements TaskExtractionProvider
{
  private readonly apiKey: string;
  private readonly model: string;
  private readonly generationSettings: GeminiGenerationSettings;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new TaskExtractionError(
        "PROVIDER_UNAVAILABLE",
        "Gemini extraction is not configured. Add GEMINI_API_KEY or use local mode.",
      );
    }
    this.apiKey = apiKey;
    this.model = (process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite").replace(
      /^models\//,
      "",
    );
    this.generationSettings = resolveGeminiGenerationSettings();
  }

  private async request(
    input: ExtractionInput,
    repairMessage?: string,
    timeoutMs = PROVIDER_TIMEOUT_MS,
  ): Promise<SemanticDraft> {
    const prompt = [
      SEMANTIC_DRAFT_INSTRUCTIONS,
      `Current local date: ${input.currentLocalDate}`,
      `IANA time zone: ${input.timeZone}`,
      input.sourceId ? `Source id: ${input.sourceId}` : "",
      repairMessage ? `Repair request: ${repairMessage}` : "",
      `Required JSON schema: ${JSON.stringify(GEMINI_SEMANTIC_DRAFT_SCHEMA)}`,
      input.structureHint ?? "",
      globalInstructionPrompt(input),
      "Source content:",
      input.text,
    ]
      .filter(Boolean)
      .join("\n");
    const startedAt = Date.now();
    const response = await fetchWithTransientRetry(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
          "x-goog-api-client": "planpilot/0.1.0",
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: generationConfig(
            this.generationSettings,
            16_384,
          ),
        }),
      },
      timeoutMs,
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
        {
          fallbackReason:
            response.status === 429 ? "rate_limited" : "provider_unavailable",
        },
      );
    }
    const payload = (await response.json()) as GeminiResponse;
    logUsage("semantic", input, payload, Date.now() - startedAt);
    const candidate = payload.candidates?.[0];
    if (candidate?.finishReason?.toUpperCase() === "MAX_TOKENS") {
      throw new TaskExtractionError(
        "INVALID_PROVIDER_OUTPUT",
        "Gemini reached its output-token limit before returning a complete interpretation.",
        { fallbackReason: "output_token_limit" },
      );
    }
    const text = candidate?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("")
      .trim();
    if (!text) {
      throw new TaskExtractionError(
        "INVALID_PROVIDER_OUTPUT",
        "Gemini returned no structured result.",
        { fallbackReason: "empty_provider_output" },
      );
    }
    try {
      return semanticDraftSchema.parse(
        repairMissingOccurrenceDates(
          normalizeSemanticDraftProviderOutput(JSON.parse(text)),
          input,
        ),
      );
    } catch (error) {
      if (error instanceof ZodError) {
        logValidationIssues("semantic-response", error);
        throw error;
      }
      if (error instanceof SyntaxError) {
        if (process.env.GEMINI_LOG_USAGE === "1") {
          console.warn(
            `[gemini-validation] ${JSON.stringify({
              stage: "semantic-response",
              issues: [{ path: "", code: "invalid_json", message: error.message }],
            })}`,
          );
        }
        throw error;
      }
      throw new TaskExtractionError(
        "INVALID_PROVIDER_OUTPUT",
        "Gemini returned malformed structured data.",
        { cause: error },
      );
    }
  }

  async extractTasks(input: ExtractionInput): Promise<ExtractionResult> {
    try {
      const deadline = Date.now() + PROVIDER_TIMEOUT_MS;
      let draft: SemanticDraft;
      try {
        draft = await this.request(
          input,
          undefined,
          deadline - Date.now(),
        );
      } catch (error) {
        if (!(error instanceof ZodError) && !(error instanceof SyntaxError)) {
          throw error;
        }
        const repairDetail =
          error instanceof ZodError ? error.issues : error.message;
        try {
          draft = await this.request(
            input,
            `The prior semantic draft failed validation. Return a complete corrected draft without adding facts. Error: ${JSON.stringify(repairDetail)}`,
            deadline - Date.now(),
          );
        } catch (repairError) {
          if (
            repairError instanceof TaskExtractionError &&
            repairError.code === "PROVIDER_UNAVAILABLE"
          ) {
            throw repairError;
          }
          throw new TaskExtractionError(
            "INVALID_PROVIDER_OUTPUT",
            "Gemini's semantic draft could not be validated after one repair attempt. Your pasted text is still safe to retry.",
            {
              cause: repairError,
              fallbackReason:
                repairError instanceof SyntaxError
                  ? "malformed_provider_output"
                  : "schema_validation_failed",
            },
          );
        }
      }
      return validateAndDedupeExtraction(
        compileSemanticDraft(input, draft),
      );
    } catch (error) {
      if (error instanceof TaskExtractionError) throw error;
      if (error instanceof ZodError) {
        logValidationIssues("compiled-result", error);
        throw new TaskExtractionError(
          "INVALID_PROVIDER_OUTPUT",
          "Gemini's semantic draft could not be compiled safely.",
          { cause: error, fallbackReason: "schema_validation_failed" },
        );
      }
      const timedOut =
        error instanceof DOMException &&
        ["AbortError", "TimeoutError"].includes(error.name);
      throw new TaskExtractionError(
        "PROVIDER_UNAVAILABLE",
        "Gemini extraction is temporarily unavailable.",
        {
          cause: error,
          fallbackReason: timedOut
            ? "request_timed_out"
            : "provider_unavailable",
        },
      );
    }
  }
}
