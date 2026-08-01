import { NextResponse } from "next/server";
import { z } from "zod";
import { MockTaskExtractionProvider } from "@/lib/providers/mock-extraction";
import { OpenAITaskExtractionProvider } from "@/lib/providers/openai-extraction";
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

type ExtractionMode = "ai" | "local";

function provider(): { extractor: TaskExtractionProvider; mode: ExtractionMode } {
  const configured = process.env.TASK_EXTRACTION_PROVIDER ?? "auto";
  const useOpenAI =
    configured === "openai" ||
    (configured === "auto" && Boolean(process.env.OPENAI_API_KEY));
  return useOpenAI
    ? { extractor: new OpenAITaskExtractionProvider(), mode: "ai" }
    : { extractor: new MockTaskExtractionProvider(), mode: "local" };
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
    const selected = provider();
    const result = await selected.extractor.extractTasks(parsed.data);
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
