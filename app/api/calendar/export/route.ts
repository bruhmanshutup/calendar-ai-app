import { NextResponse } from "next/server";
import { z } from "zod";
import { createCalendarFile } from "@/lib/providers/icalendar";

const sessionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
  status: z.literal("approved"),
  explanation: z.string(),
}).refine((session) => Date.parse(session.end) > Date.parse(session.start), {
  message: "Session end must be after its start.",
});

const requestSchema = z.object({
  explicitlyApproved: z.literal(true),
  reminderMinutes: z.number().int().min(0).max(40_320),
  sessions: z.array(sessionSchema).min(1).max(1000).refine(
    (sessions) => new Set(sessions.map((session) => session.id)).size === sessions.length,
    { message: "Each session must have a unique ID." },
  ),
});

export async function POST(request: Request): Promise<Response> {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_CALENDAR_EXPORT",
          message:
            "Export requires 1–1,000 explicitly approved sessions with valid start and end times and unique IDs.",
        },
      },
      { status: 400 },
    );
  }
  const calendar = createCalendarFile(
    parsed.data.sessions,
    parsed.data.reminderMinutes,
  );
  return new Response(calendar, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="planpilot-schedule.ics"',
      "Cache-Control": "no-store",
    },
  });
}
