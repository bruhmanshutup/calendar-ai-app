import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { generateSchedule } from "../lib/domain/scheduler";
import { proposeMinimalReplan } from "../lib/domain/rescheduler";
import { MockCalendarProvider } from "../lib/providers/mock-calendar";
import { MockTaskExtractionProvider } from "../lib/providers/mock-extraction";
import { scheduling } from "./fixtures";
import { POST as exportCalendar } from "../app/api/calendar/export/route";

describe("vertical workflow integration", () => {
  it("runs paste → extract → review → schedule → approve → export → missed → replan", async () => {
    const extraction = await new MockTaskExtractionProvider().extractTasks({
      text: "Chemistry homework due Friday at 5 PM. About 90 minutes.\nGo to the gym three times this week, 45 minutes each.\nFYI: Lab is in room 204.",
      currentLocalDate: "2026-07-30",
      timeZone: "UTC",
    });
    expect(extraction.tasks).toHaveLength(2);
    expect(extraction.ignoredStatements).toHaveLength(1);

    const reviewed = extraction.tasks.map((task) => ({
      ...task,
      approved: true,
      reviewRequired: false,
      missingInformation: [],
    }));
    const proposal = generateSchedule(scheduling(reviewed));
    expect(proposal.sessions.length).toBeGreaterThan(0);
    expect(
      proposal.sessions.every((session) => session.explanation.length > 0),
    ).toBe(true);

    const approved = proposal.sessions.map((session) => ({
      ...session,
      status: "approved" as const,
    }));
    const download = await exportCalendar(new Request("http://localhost/api/calendar/export", {
      method: "POST",
      body: JSON.stringify({ explicitlyApproved: true, reminderMinutes: 10, sessions: approved }),
    }));
    expect(download.status).toBe(200);
    expect((await download.text()).match(/^BEGIN:VEVENT$/gm)).toHaveLength(approved.length);
    const calendar = new MockCalendarProvider();
    const exportedId = await calendar.createEvent({
      idempotencyKey: `planpilot:${approved[0].id}`,
      title: approved[0].title,
      start: approved[0].start,
      end: approved[0].end,
      description: approved[0].explanation,
      reminderMinutes: 10,
      session: approved[0],
    });
    expect(exportedId).toMatch(/^mock-calendar-/);
    expect(
      await calendar.createEvent({
        idempotencyKey: `planpilot:${approved[0].id}`,
        title: approved[0].title,
        start: approved[0].start,
        end: approved[0].end,
        description: approved[0].explanation,
        reminderMinutes: 10,
        session: approved[0],
      }),
    ).toBe(exportedId);

    const missed = {
      id: approved[0].id,
      taskId: approved[0].taskId,
      title: approved[0].title,
      start: approved[0].start,
      end: approved[0].end,
      locked: false,
      status: "missed" as const,
    };
    const base = scheduling([]);
    const replan = proposeMinimalReplan({
      session: missed,
      outcome: "missed",
      sessions: [
        missed,
        ...approved.slice(1).map((session) => ({
          id: session.id,
          taskId: session.taskId,
          title: session.title,
          start: session.start,
          end: session.end,
          locked: session.locked,
          status: "approved" as const,
        })),
      ],
      task: reviewed.find((task) => task.id === missed.taskId)!,
      scheduling: {
        windowStart: base.windowStart,
        windowEnd: base.windowEnd,
        preferences: base.preferences,
        availability: base.availability,
        unavailableEvents: base.unavailableEvents,
        blockedTimes: base.blockedTimes,
      },
    });
    expect(replan.changes.length).toBeGreaterThan(0);
    expect(replan.explanation).toContain("No other sessions need to move");
  });

  it("protects every user-owned Supabase table with RLS policies", async () => {
    const sql = await readFile(
      new URL(
        "../supabase/migrations/202607300001_planpilot_core.sql",
        import.meta.url,
      ),
      "utf8",
    );
    for (const table of [
      "profiles",
      "user_preferences",
      "task_sources",
      "tasks",
      "task_history",
      "availability_rules",
      "calendar_connections",
      "external_calendar_events",
      "schedule_versions",
      "planned_sessions",
    ]) {
      expect(sql).toContain(
        `alter table public.${table} enable row level security;`,
      );
    }
    expect(sql).toContain("(select auth.uid()) = user_id");
    expect(sql).toContain(
      "revoke update, delete on public.task_history from authenticated;",
    );
  });
});

