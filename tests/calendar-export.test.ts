import { describe, expect, it } from "vitest";
import { POST } from "../app/api/calendar/export/route";
import { createCalendarFile, type CalendarExportSession } from "../lib/providers/icalendar";

const session: CalendarExportSession = {
  id: "session-homework-1",
  title: "Chemistry homework",
  start: "2026-09-28T09:00:00-05:00",
  end: "2026-09-28T09:45:00-05:00",
  status: "approved",
  explanation: "Work before the deadline.",
};
const now = new Date("2026-09-28T12:00:00Z");
const unfold = (value: string) => value.replace(/\r\n /g, "");
const exportRequest = (overrides: Record<string, unknown> = {}) => POST(new Request(
  "http://localhost/api/calendar/export",
  {
    method: "POST",
    body: JSON.stringify({ explicitlyApproved: true, reminderMinutes: 10, sessions: [session], ...overrides }),
    headers: { "Content-Type": "application/json" },
  },
));

describe("Google Calendar file export", () => {
  it("includes required calendar fields and preserves absolute session times", () => {
    const file = createCalendarFile([session], 10, now);
    expect(file).toMatch(/^BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:/);
    expect(file).toContain("UID:session-homework-1@planpilot\r\n");
    expect(file).toContain("DTSTAMP:20260928T120000Z\r\n");
    expect(file).toContain("DTSTART:20260928T140000Z\r\nDTEND:20260928T144500Z");
    expect(file).toContain("SUMMARY:Chemistry homework\r\n");
    expect(unfold(file)).toContain("DESCRIPTION:Work before the deadline.\\n\\nPlanPilot session: session-homework-1");
    expect(file).toContain("TRIGGER:-PT10M\r\n");
    expect(file).toMatch(/END:VEVENT\r\nEND:VCALENDAR\r\n$/);
    expect(file.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("preserves times across daylight saving changes and overnight sessions", () => {
    const file = createCalendarFile([
      { ...session, start: "2026-11-01T01:30:00-05:00", end: "2026-11-01T01:30:00-06:00" },
      { ...session, id: "overnight", start: "2026-11-01T23:30:00-06:00", end: "2026-11-02T00:30:00-06:00" },
    ], 0, now);
    expect(file).toContain("DTSTART:20261101T063000Z\r\nDTEND:20261101T073000Z");
    expect(file).toContain("DTSTART:20261102T053000Z\r\nDTEND:20261102T063000Z");
    expect(file).not.toContain("VALARM");
  });

  it("escapes special characters and prevents text from injecting calendar properties", () => {
    const title = "Study, lab; C:\\notes\r\nEND:VEVENT\nBEGIN:VEVENT";
    const file = unfold(createCalendarFile([{ ...session, title }], 0, now));
    expect(file).toContain("SUMMARY:Study\\, lab\\; C:\\\\notes\\nEND:VEVENT\\nBEGIN:VEVENT\r\n");
    expect(file.match(/^BEGIN:VEVENT$/gm)).toHaveLength(1);
    expect(file.match(/^END:VEVENT$/gm)).toHaveLength(1);
  });

  it("folds long Unicode text at 75 bytes without corrupting characters", () => {
    const title = "Résumé 📚 学習 ".repeat(30);
    const file = createCalendarFile([{ ...session, title }], 10, now);
    for (const line of file.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    expect(unfold(file)).toContain(`SUMMARY:${title}\r\n`);
    expect(file).not.toContain("�");
  });

  it("keeps event identifiers stable when the same session is exported again", () => {
    const first = createCalendarFile([session], 0, now);
    const second = createCalendarFile([{ ...session, title: "Updated title" }], 0, new Date("2026-09-29"));
    expect(first.match(/^UID:.+$/m)?.[0]).toBe(second.match(/^UID:.+$/m)?.[0]);
  });

  it("returns a downloadable ICS response, including manually placed sessions", async () => {
    const response = await exportRequest({ sessions: [{ ...session, reasonCodes: ["USER_PLACEMENT", "OVERDUE_RECOVERY"] }] });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="planpilot-schedule.ics"');
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toContain("BEGIN:VEVENT");
  });

  it("exports more than the old 100-session limit as individual occurrences", async () => {
    const sessions = Array.from({ length: 101 }, (_, index) => ({ ...session, id: `session-${index}` }));
    const response = await exportRequest({ sessions });
    expect(response.status).toBe(200);
    const file = await response.text();
    expect(file.match(/^BEGIN:VEVENT$/gm)).toHaveLength(101);
    expect(file).not.toContain("RRULE:");
  });

  it.each(["proposed", "in_progress", "completed", "partial", "missed", "unnecessary"])(
    "rejects a mixed batch containing a %s session",
    async (status) => {
      const response = await exportRequest({ sessions: [session, { ...session, id: "other", status }] });
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("BEGIN:VCALENDAR");
    },
  );

  it.each([
    { explicitlyApproved: false },
    { sessions: [] },
    { sessions: [session, session] },
    { sessions: [{ ...session, end: session.start }] },
    { sessions: [{ ...session, end: "2026-09-27T09:00:00-05:00" }] },
    { sessions: [{ ...session, start: "not-a-date" }] },
    { sessions: [{ ...session, start: "2026-09-28T09:00:00" }] },
    { reminderMinutes: -10 },
  ])("rejects invalid export input: %j", async (overrides) => {
    expect((await exportRequest(overrides)).status).toBe(400);
  });

  it("returns a recoverable error for malformed JSON", async () => {
    const response = await POST(new Request("http://localhost/api/calendar/export", { method: "POST", body: "{" }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain("approved sessions");
  });
});
