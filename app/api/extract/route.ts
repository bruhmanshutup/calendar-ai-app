import { NextResponse } from "next/server";
import { z } from "zod";
import { prepareGlobalInstructions } from "@/lib/domain/global-instructions";
import { MockTaskExtractionProvider } from "@/lib/providers/mock-extraction";
import { GeminiTaskExtractionProvider } from "@/lib/providers/gemini-extraction";
import { OpenAITaskExtractionProvider } from "@/lib/providers/openai-extraction";
import {
  TaskExtractionError,
  type TaskExtractionProvider,
} from "@/lib/providers/task-extraction";
import {
  runExtractionPipeline,
  runLocalFallbackPipeline,
  type SemanticProviderName,
} from "@/lib/providers/extraction-pipeline";

const EXTRACTION_ABORT_MS = 45_000;

const requestSchema = z.object({
  globalInstructions: z.string().max(4000).optional(),
  allowInlineGlobalInstructions: z.boolean().optional(),
  text: z.string().trim().min(1).max(100_000),
  currentLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timeZone: z.string().trim().min(1).max(100),
  sourceId: z.string().optional(),
});

type ExtractionMode = "gemini" | "openai" | "local" | "fast-local";

function provider(): {
  extractor: TaskExtractionProvider;
  mode: ExtractionMode;
} {
  const configured = process.env.TASK_EXTRACTION_PROVIDER ?? "auto";
  if (
    configured === "gemini" ||
    (configured === "auto" && Boolean(process.env.GEMINI_API_KEY))
  ) {
    return { extractor: new GeminiTaskExtractionProvider(), mode: "gemini" };
  }
  if (
    configured === "openai" ||
    (configured === "auto" && Boolean(process.env.OPENAI_API_KEY))
  ) {
    return { extractor: new OpenAITaskExtractionProvider(), mode: "openai" };
  }
  return { extractor: new MockTaskExtractionProvider(), mode: "local" };
}

export async function POST(request: Request): Promise<Response> {
  const parsed = requestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_INPUT",
          message: "Check the pasted text, local date, and IANA time zone.",
          details: parsed.error.issues,
        },
      },
      { status: 400 },
    );
  }
  try {
    // A provider call must never be allowed to hold the worker indefinitely.
    // The browser gives the route 60 seconds; abort the upstream call earlier
    // so auto mode can return its deterministic fallback with a review flag.
    const controller = new AbortController();
    const extractionInput = { ...parsed.data, signal: controller.signal };
    const selected = provider();
    const configured = process.env.TASK_EXTRACTION_PROVIDER ?? "auto";
    const semanticProviderName: SemanticProviderName | undefined =
      selected.mode === "gemini" || selected.mode === "openai"
        ? selected.mode
        : undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const pipelinePromise = runExtractionPipeline(extractionInput, {
        semanticProviderName,
        semanticProvider: semanticProviderName ? selected.extractor : undefined,
        localProvider: new MockTaskExtractionProvider(),
        // Auto mode may use the reviewed local fallback. Explicit AI mode must
        // return its typed provider error instead of silently changing meaning.
        allowLocalFallback: configured === "auto",
        architecture: "hybrid",
      });
      const timeoutPromise = new Promise<undefined>((resolve) => {
        timeoutHandle = setTimeout(() => {
          controller.abort();
          resolve(undefined);
        }, EXTRACTION_ABORT_MS);
      });
      const pipeline = await Promise.race([pipelinePromise, timeoutPromise]);
      if (!pipeline) {
        // The upstream call may not honor cancellation immediately in every
        // runtime. Keep its rejection handled, but return a bounded, clearly
        // labeled local result so one slow request cannot hold the worker.
        void pipelinePromise.catch(() => undefined);
        if (prepareGlobalInstructions(extractionInput).rules.length) {
          throw new TaskExtractionError("PROVIDER_UNAVAILABLE", "AI interpretation timed out. Global instructions require AI; retry this import. Your source and rules are preserved.");
        }
        const fallbackProvider = new MockTaskExtractionProvider();
        const localResult = await fallbackProvider.extractTasks(parsed.data);
        const recovered = await runLocalFallbackPipeline(parsed.data, localResult);
        const reviewed = semanticProviderName
          ? {
              ...recovered,
              tasks: recovered.tasks.map((task) => ({
                ...task,
                approved: false,
                reviewRequired: true,
                missingInformation: [
                  ...task.missingInformation,
                  "AI interpretation timed out; verify the task type, dates, times, and relationships.",
                ].filter(
                  (item, index, all) => all.indexOf(item) === index,
                ),
              })),
            }
          : recovered;
        return NextResponse.json({
          ...reviewed,
          extractionMode: semanticProviderName ? "local-fallback" : "local",
          extractionReport: {
            ...(semanticProviderName ? { semanticProvider: semanticProviderName } : {}),
            semanticProviderAttempted: Boolean(semanticProviderName),
            semanticProviderUsed: false,
            localEvidenceUsed: false,
            localFallbackUsed: Boolean(semanticProviderName),
            comparedTaskCount: 0,
            reconciliationReviewCount: 0,
            ...(semanticProviderName ? { fallbackReason: "request_timed_out" as const } : {}),
          },
        });
      }
      return NextResponse.json({
        ...pipeline.result,
        extractionMode: pipeline.extractionMode,
        extractionReport: pipeline.report,
      });
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  } catch (error) {
    const typed =
      error instanceof TaskExtractionError
        ? error
        : new TaskExtractionError(
            "PROVIDER_UNAVAILABLE",
            "Task extraction is temporarily unavailable. Your pasted text was not discarded.",
          );
    return NextResponse.json(
      { error: { code: typed.code, message: typed.message } },
      { status: typed.code === "INVALID_PROVIDER_OUTPUT" ? 422 : 503 },
    );
  }
}
