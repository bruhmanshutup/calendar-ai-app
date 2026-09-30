import type { PlannedSession } from "@/lib/domain/types";

export type CalendarExportSession = Pick<
  PlannedSession,
  "id" | "title" | "start" | "end" | "explanation"
> & { status: "approved" };

function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

// RFC 5545 limits content lines to 75 UTF-8 octets, including the
// continuation space. Iterate code points so folding never splits an emoji.
function foldLine(value: string): string {
  const encoder = new TextEncoder();
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const length = encoder.encode(character).length;
    if (bytes + length > 75) {
      result += "\r\n ";
      bytes = 1;
    }
    result += character;
    bytes += length;
  }
  return result;
}

function utcTimestamp(value: string | Date): string {
  return new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Export concrete approved occurrences, without extending recurring plans. */
export function createCalendarFile(
  sessions: CalendarExportSession[],
  reminderMinutes: number,
  now = new Date(),
): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//PlanPilot//Approved Schedule//EN",
    "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:PlanPilot",
  ];
  for (const session of sessions) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeText(session.id)}@planpilot`,
      `DTSTAMP:${utcTimestamp(now)}`,
      `DTSTART:${utcTimestamp(session.start)}`,
      `DTEND:${utcTimestamp(session.end)}`,
      `SUMMARY:${escapeText(session.title)}`,
      `DESCRIPTION:${escapeText(`${session.explanation}\n\nPlanPilot session: ${session.id}`)}`,
      "STATUS:CONFIRMED",
      "TRANSP:OPAQUE",
    );
    if (reminderMinutes > 0) {
      lines.push(
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `TRIGGER:-PT${reminderMinutes}M`,
        `DESCRIPTION:${escapeText(session.title)}`,
        "END:VALARM",
      );
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
