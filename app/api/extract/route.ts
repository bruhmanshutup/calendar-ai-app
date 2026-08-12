import { NextResponse } from "next/server";
import { z } from "zod";
import { MockTaskExtractionProvider } from "@/lib/providers/mock-extraction";
import { GeminiTaskExtractionProvider } from "@/lib/providers/gemini-extraction";
import { OpenAITaskExtractionProvider } from "@/lib/providers/openai-extraction";
import { recoverExplicitOverdueTasks } from "@/lib/providers/overdue-recovery";
import { recoverTimedRecurrences } from "@/lib/providers/recurrence-recovery";
import { recoverFlexibleRecurrences } from "@/lib/providers/flexible-recurrence-recovery";
import {
  prepareStructuredPlanExtractionInput,
  recoverStructuredLearningPlan,
} from "@/lib/providers/structured-plan-recovery";
import {
  TaskExtractionError,
  type TaskExtractionProvider,
} from "@/lib/providers/task-extraction";

const requestSchema = z.object({
  text: z.string().trim().min(1).max(100_000),
  currentLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timeZone: z.string().trim().min(1).max(100),
  sourceId: z.string().optional(),
});

type ExtractionMode = "gemini" | "openai" | "local";

function provider(): { extractor: TaskExtractionProvider; mode: ExtractionMode } {
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
    let selected = provider();
    const extractionInput = prepareStructuredPlanExtractionInput(parsed.data);
    let extracted: Awaited<ReturnType<TaskExtractionProvider["extractTasks"]>>;
    try {
      extracted = await selected.extractor.extractTasks(extractionInput);
    } catch (error) {
      if (selected.mode === "local") throw error;
      selected = {
        extractor: new MockTaskExtractionProvider(),
        mode: "local",
      };
      extracted = await selected.extractor.extractTasks(extractionInput);
    }
    const withOverdueRecovery = await recoverExplicitOverdueTasks(
      parsed.data,
      extracted,
    );
    const withTimedRecurrences = await recoverTimedRecurrences(
      parsed.data,
      withOverdueRecovery,
    );
    const withFlexibleRecurrences = await recoverFlexibleRecurrences(
      parsed.data,
      withTimedRecurrences,
    );
    const result = recoverStructuredLearningPlan(
      parsed.data,
      withFlexibleRecurrences,
    );
    return NextResponse.json({ ...result, extractionMode: selected.mode });
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
