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

function provider(): TaskExtractionProvider {
  return process.env.TASK_EXTRACTION_PROVIDER === "openai"
    ? new OpenAITaskExtractionProvider()
    : new MockTaskExtractionProvider();
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
    const result = await provider().extractTasks(parsed.data);
    return NextResponse.json(result);
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

