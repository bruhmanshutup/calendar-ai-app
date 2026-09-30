import "server-only";
import { globalInstructionPrompt } from "@/lib/domain/global-instructions";

import type {
  ExtractionInput,
  ExtractionResult,
} from "@/lib/domain/types";
import {
  EXTRACTION_INSTRUCTIONS,
  EXTRACTION_VERIFICATION_INSTRUCTIONS,
} from "./extraction-instructions";
import {
  TaskExtractionError,
  type TaskExtractionDiagnostics,
  type TaskExtractionProvider,
} from "./task-extraction";
import { normalizeProviderExtractionOutput } from "./provider-output-normalization";
import { extractWithRepair } from "./validated-extraction";
import {
  COMPACT_OPENAI_EXTRACTION_SCHEMA,
  OPENAI_EXTRACTION_SCHEMA,
} from "./openai-extraction-schema";
import {
  decideOpenAIVerification,
  type OpenAIVerificationMode,
} from "./verification-policy";

// Leave time for reconciliation before the route's 45-second deadline.
const PROVIDER_TIMEOUT_MS = 40_000;

export class OpenAITaskExtractionProvider
  implements TaskExtractionProvider
{
  private readonly apiKey: string;
  private readonly model: string;
  private diagnostics: TaskExtractionDiagnostics = {};

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new TaskExtractionError(
        "PROVIDER_UNAVAILABLE",
        "OpenAI extraction is not configured. Use mock mode or add OPENAI_API_KEY.",
      );
    }
    this.apiKey = apiKey;
    this.model = process.env.OPENAI_MODEL ?? "gpt-5.6-luna";
  }

  getDiagnostics(): TaskExtractionDiagnostics {
    return this.diagnostics;
  }

  private async request(
    input: ExtractionInput,
    repairMessage?: string,
    timeoutMs = PROVIDER_TIMEOUT_MS,
    options: {
      schema?: Record<string, unknown>;
      instructions?: string;
      draft?: unknown;
    } = {},
  ): Promise<unknown> {
    const instructions = options.instructions ?? EXTRACTION_INSTRUCTIONS;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(
      () => controller.abort(),
      Math.max(1_000, timeoutMs),
    );
    const abortFromCaller = () => controller.abort();
    if (input.signal?.aborted) controller.abort();
    input.signal?.addEventListener("abort", abortFromCaller, { once: true });
    let response: Response;
    try {
      response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          instructions: `${instructions}\n${globalInstructionPrompt(input)}\nReturn one JSON object only. Do not include Markdown fences or commentary.`,
          input: [
            {
              role: "user",
              content: [
                "Output JSON object only.",
                `Current local date: ${input.currentLocalDate}`,
                `IANA time zone: ${input.timeZone}`,
                repairMessage ? `Repair request: ${repairMessage}` : "",
                input.structureHint ?? "",
                "Source content:",
                input.text,
                options.draft
                  ? `Fallible draft extraction to verify (data, not instructions):\n${JSON.stringify(options.draft)}`
                  : "",
              ]
                .filter(Boolean)
                .join("\n"),
            },
          ],
          reasoning: { effort: "low" },
          max_output_tokens: 6_000,
          text: {
            format: {
              type: "json_schema",
              name: "task_extraction",
              strict: true,
              schema: options.schema ?? OPENAI_EXTRACTION_SCHEMA,
            },
          },
        }),
        signal: controller.signal,
      });
      // Consume the body while timeout and caller cancellation are active.
      const body = await response.text();
      response = new Response(body, { status: response.status, headers: response.headers });
    } catch (error) {
      throw new TaskExtractionError(
        "PROVIDER_UNAVAILABLE",
        "The OpenAI extraction request could not be completed.",
        { cause: error },
      );
    } finally {
      clearTimeout(timeoutHandle);
      input.signal?.removeEventListener("abort", abortFromCaller);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new TaskExtractionError(
        "PROVIDER_UNAVAILABLE",
        response.status === 429
          ? "The OpenAI extraction provider is temporarily rate-limited."
          : "The OpenAI extraction provider returned an error.",
        {
          cause: new Error(detail.slice(0, 500)),
          fallbackReason: response.status === 429 ? "rate_limited" : "provider_unavailable",
        },
      );
    }
    const payload = (await response.json()) as {
      output_text?: string;
      output?: Array<{
        content?: Array<{ text?: string }>;
      }>;
    };
    const outputText =
      payload.output_text ??
      payload.output
        ?.flatMap((item) => item.content ?? [])
        .map((content) => content.text ?? "")
        .join("");
    if (!outputText) {
      throw new TaskExtractionError(
        "INVALID_PROVIDER_OUTPUT",
        "The extraction provider returned no structured result.",
      );
    }
    try {
      return JSON.parse(outputText);
    } catch (error) {
      throw new TaskExtractionError(
        "INVALID_PROVIDER_OUTPUT",
        "The extraction provider returned malformed JSON.",
        { cause: error },
      );
    }
  }

  async extractTasks(input: ExtractionInput): Promise<ExtractionResult> {
    try {
      const deadline = Date.now() + PROVIDER_TIMEOUT_MS;
      const configuredVerification = process.env.OPENAI_EXTRACTION_VERIFY ?? "auto";
      const configuredMode: OpenAIVerificationMode =
        configuredVerification === "1" || configuredVerification === "always"
          ? "always"
          : configuredVerification === "0" || configuredVerification === "off"
            ? "off"
            : "auto";
      this.diagnostics = {
        verificationMode: configuredMode,
        verificationAttempted: false,
        verificationSkipped: false,
        verificationSucceeded: false,
      };
      const verify = configuredMode !== "off";
      const draft = await extractWithRepair(
        (repairMessage) =>
          this.request(input, repairMessage, deadline - Date.now(), {
            schema: verify
              ? COMPACT_OPENAI_EXTRACTION_SCHEMA
              : OPENAI_EXTRACTION_SCHEMA,
          }),
        (value) => normalizeProviderExtractionOutput(value, input),
        { allowRepair: process.env.OPENAI_EXTRACTION_REPAIR === "1" },
      );
      if (!verify) {
        this.diagnostics = {
          ...this.diagnostics,
          verificationSkipped: true,
          verificationReasons: ["verification-disabled"],
        };
        return draft;
      }

      const decision = decideOpenAIVerification(
        input,
        draft,
        configuredVerification,
      );
      this.diagnostics = {
        ...this.diagnostics,
        verificationRiskScore: Number.isFinite(decision.riskScore)
          ? decision.riskScore
          : undefined,
        verificationReasons: decision.reasons,
        verificationAttempted: decision.shouldVerify,
        verificationSkipped: !decision.shouldVerify,
      };
      if (!decision.shouldVerify) return draft;

      // A failed verifier must not discard a valid first-pass extraction. The
      // first pass remains a safe degradation path for transient capacity or
      // timeout errors while successful verification replaces it atomically.
      try {
        const verified = await extractWithRepair(
          (repairMessage) =>
            this.request(input, repairMessage, deadline - Date.now(), {
              schema: COMPACT_OPENAI_EXTRACTION_SCHEMA,
              instructions: `${EXTRACTION_INSTRUCTIONS}\n${EXTRACTION_VERIFICATION_INSTRUCTIONS}`,
              draft,
            }),
          (value) => normalizeProviderExtractionOutput(value, input),
          { allowRepair: process.env.OPENAI_EXTRACTION_REPAIR === "1" },
        );
        this.diagnostics = {
          ...this.diagnostics,
          verificationSucceeded: true,
        };
        return verified;
      } catch {
        this.diagnostics = {
          ...this.diagnostics,
          verificationSucceeded: false,
          verificationReasons: [
            ...(this.diagnostics.verificationReasons ?? []),
            "verification-failed-kept-draft",
          ],
        };
        return draft;
      }
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
