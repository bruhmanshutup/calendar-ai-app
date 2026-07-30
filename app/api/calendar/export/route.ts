import { NextResponse } from "next/server";
import { z } from "zod";
import { MockCalendarProvider } from "@/lib/providers/mock-calendar";

const sessionSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  title: z.string(),
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
  minutes: z.number().int().positive(),
  status: z.literal("approved"),
  locked: z.boolean(),
  reasonCodes: z.array(
    z.enum([
      "DEADLINE_RISK",
      "PREFERRED_FOCUS_WINDOW",
      "PREFERRED_ROUTINE_WINDOW",
      "PRIORITY",
      "EARLY_COMPLETION",
      "SPLIT_TO_REDUCE_FATIGUE",
      "RECURRING_SPACING",
      "BUFFER_PRESERVED",
      "LOW_ENERGY_FIT",
      "FINAL_VALID_OPENING",
      "STABILITY_PRESERVED",
      "MOVED_AFTER_MISSED",
      "FIXED_TIME",
    ]),
  ),
  explanation: z.string(),
});

const requestSchema = z.object({
  explicitlyApproved: z.literal(true),
  reminderMinutes: z.number().int().min(0).max(40_320),
  sessions: z.array(sessionSchema).min(1).max(100),
});

const mockCalendar = new MockCalendarProvider();

export async function POST(request: Request): Promise<Response> {
  const parsed = requestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "APPROVAL_REQUIRED",
          message:
            "Only explicitly approved PlanPilot sessions can be exported.",
        },
      },
      { status: 400 },
    );
  }
  const ids = await Promise.all(
    parsed.data.sessions.map((session) =>
      mockCalendar.createEvent({
        idempotencyKey: `planpilot:${session.id}`,
        title: session.title,
        start: session.start,
        end: session.end,
        description: `${session.explanation}\n\nPlanPilot session: ${session.id}`,
        reminderMinutes: parsed.data.reminderMinutes,
        session,
      }),
    ),
  );
  return NextResponse.json({ eventIds: ids, provider: "mock" });
}
