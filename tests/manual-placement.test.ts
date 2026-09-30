import { describe, expect, it } from "vitest";
import {
  deadlineUpdateFields,
  isManualPlacementAfterDeadline,
  manuallyPlacedBreak,
  manuallyPlacedSession,
  manualPlacementEnd,
  manualPlacementStart,
  sessionsForManualPlacementReflow,
  taskDeadlineInstant,
} from "../lib/domain/manual-placement";
import { generateSchedule } from "../lib/domain/scheduler";
import type { PlannedSession } from "../lib/domain/types";
import { scheduling, task } from "./fixtures";

const TIME_ZONE = "America/Los_Angeles";

function session(patch: Partial<PlannedSession> = {}): PlannedSession {
  return {
    id: "session-manual-1",
    taskId: "manual",
    title: "Manual decision",
    start: "2026-08-17T16:00:00.000Z",
    end: "2026-08-17T16:45:00.000Z",
    minutes: 45,
    status: "proposed",
    locked: false,
    reviewAfter: "2026-08-17T17:00:00.000Z",
    reasonCodes: ["EARLY_COMPLETION"],
    explanation: "Original placement.",
    ...patch,
  };
}

describe("manual schedule placement", () => {
  it("converts exact local wall-clock choices in summer and winter", () => {
    expect(manualPlacementStart("2026-08-17", "09:30", TIME_ZONE)).toBe(
      "2026-08-17T16:30:00.000Z",
    );
    expect(manualPlacementStart("2026-12-17", "09:30", TIME_ZONE)).toBe(
      "2026-12-17T17:30:00.000Z",
    );
  });

  it("rejects normalized or impossible wall-clock choices", () => {
    expect(() =>
      manualPlacementStart("2026-03-08", "02:30", TIME_ZONE),
    ).toThrow(/valid placement/i);
    expect(() =>
      manualPlacementStart("2026-08-17", "24:00", TIME_ZONE),
    ).toThrow(/valid placement/i);
    expect(() =>
      manualPlacementStart("2026-02-30", "09:00", TIME_ZONE),
    ).toThrow(/valid placement/i);
  });

  it("keeps the exact duration across midnight", () => {
    const start = manualPlacementStart("2026-08-17", "23:45", TIME_ZONE);
    expect(manualPlacementEnd(start, 45)).toBe("2026-08-18T07:30:00.000Z");
  });

  it("locks the chosen session and clears stale review timing", () => {
    const moved = manuallyPlacedSession(
      session(),
      "2026-08-18T20:15:00.000Z",
    );

    expect(moved).toMatchObject({
      id: "session-manual-1",
      taskId: "manual",
      start: "2026-08-18T20:15:00.000Z",
      end: "2026-08-18T21:00:00.000Z",
      minutes: 45,
      status: "proposed",
      locked: true,
      reasonCodes: ["USER_PLACEMENT"],
      reviewAfter: undefined,
    });
  });

  it("moves an attached recovery break with the manually placed session", () => {
    const moved = manuallyPlacedSession(
      session(),
      "2026-08-18T23:00:00.000Z",
    );

    expect(
      manuallyPlacedBreak(
        moved,
        {
          afterSessionId: "session-manual-1",
          start: "2026-08-17T16:45:00.000Z",
          end: "2026-08-17T17:00:00.000Z",
          minutes: 15,
        },
        10,
      ),
    ).toEqual({
      afterSessionId: "session-manual-1",
      start: "2026-08-18T23:45:00.000Z",
      end: "2026-08-19T00:00:00.000Z",
      minutes: 15,
    });
  });

  it("preserves stable work and replans only flexible sessions in the chosen slot", () => {
    const moved = manuallyPlacedSession(
      session(),
      "2026-08-18T20:00:00.000Z",
    );
    const conflict = session({
      id: "conflict",
      taskId: "conflict",
      start: "2026-08-18T20:15:00.000Z",
      end: "2026-08-18T21:00:00.000Z",
    });
    const stable = session({
      id: "stable",
      taskId: "stable",
      start: "2026-08-18T22:00:00.000Z",
      end: "2026-08-18T22:45:00.000Z",
    });
    const protectedConflict = session({
      id: "protected",
      taskId: "protected",
      start: "2026-08-18T20:30:00.000Z",
      end: "2026-08-18T21:15:00.000Z",
      locked: true,
    });

    const preserved = sessionsForManualPlacementReflow(
      [session(), conflict, stable, protectedConflict],
      [
        task({ id: "manual", title: "Manual decision" }),
        task({ id: "conflict", title: "Conflict" }),
        task({ id: "stable", title: "Stable" }),
        task({ id: "protected", title: "Protected" }),
      ],
      moved,
    );

    expect(preserved.map((item) => item.id)).toEqual([
      "session-manual-1",
      "stable",
      "protected",
    ]);
    expect(preserved[0]).toEqual(moved);
  });

  it("releases flexible sequence siblings so ordering can adapt", () => {
    const firstTask = task({
      id: "sequence-first",
      title: "Week 1, Day 1: First step",
      sequence: { groupId: "learning-plan", order: 1, minimumGapDays: 1 },
    });
    const secondTask = task({
      id: "sequence-second",
      title: "Week 1, Day 2: Second step",
      sequence: { groupId: "learning-plan", order: 2, minimumGapDays: 1 },
    });
    const first = session({ taskId: firstTask.id, id: "first" });
    const second = session({
      taskId: secondTask.id,
      id: "second",
      start: "2026-08-19T16:00:00.000Z",
      end: "2026-08-19T16:45:00.000Z",
    });
    const unrelated = session({
      taskId: "unrelated",
      id: "unrelated",
      start: "2026-08-20T16:00:00.000Z",
      end: "2026-08-20T16:45:00.000Z",
    });
    const moved = manuallyPlacedSession(first, "2026-08-21T16:00:00.000Z");

    expect(
      sessionsForManualPlacementReflow(
        [first, second, unrelated],
        [
          firstTask,
          secondTask,
          task({ id: "unrelated", title: "Unrelated" }),
        ],
        moved,
      ).map((item) => item.id),
    ).toEqual(["first", "unrelated"]);
  });

  it("warns only when the session ends after a timed deadline", () => {
    const deadlineTask = task({
      id: "timed",
      title: "Timed deadline",
      dueAt: "2026-08-17T18:00:00.000Z",
    });

    expect(
      isManualPlacementAfterDeadline(
        deadlineTask,
        "2026-08-17T18:00:00.000Z",
        TIME_ZONE,
        "23:00",
      ),
    ).toBe(false);
    expect(
      isManualPlacementAfterDeadline(
        deadlineTask,
        "2026-08-17T18:00:00.001Z",
        TIME_ZONE,
        "23:00",
      ),
    ).toBe(true);
  });

  it("uses an exact deadline before a due window, then the window start before a date", () => {
    const dueWindow = {
      start: "2026-08-19T19:00:00.000Z",
      end: "2026-08-19T23:00:00.000Z",
      label: "Wednesday afternoon",
      precision: "named_period" as const,
    };
    const exactTask = task({
      id: "exact-before-window",
      title: "Exact deadline",
      dueAt: "2026-08-19T20:30:00.000Z",
      dueWindow,
      dueDate: "2026-08-21",
    });
    const windowTask = task({
      id: "window-before-date",
      title: "Window deadline",
      dueWindow,
      dueDate: "2026-08-21",
    });

    expect(taskDeadlineInstant(exactTask, TIME_ZONE, "23:00")).toBe(
      "2026-08-19T20:30:00.000Z",
    );
    expect(taskDeadlineInstant(windowTask, TIME_ZONE, "23:00")).toBe(
      dueWindow.start,
    );
    expect(
      isManualPlacementAfterDeadline(
        windowTask,
        "2026-08-19T19:00:00.001Z",
        TIME_ZONE,
        "23:00",
      ),
    ).toBe(true);
  });

  it("uses the end of the planning day for a date-only deadline", () => {
    const deadlineTask = task({
      id: "date-only",
      title: "Date-only deadline",
      dueDate: "2026-08-17",
    });
    expect(taskDeadlineInstant(deadlineTask, TIME_ZONE, "23:00")).toBe(
      "2026-08-18T06:00:00.000Z",
    );
    expect(
      isManualPlacementAfterDeadline(
        deadlineTask,
        "2026-08-18T06:00:00.000Z",
        TIME_ZONE,
        "23:00",
      ),
    ).toBe(false);
    expect(
      isManualPlacementAfterDeadline(
        deadlineTask,
        "2026-08-18T06:15:00.000Z",
        TIME_ZONE,
        "23:00",
      ),
    ).toBe(true);
  });

  it("derives timed deadlines and clears stale instants for date-only edits", () => {
    expect(
      deadlineUpdateFields(
        { dueDate: "2026-08-21", dueTime: "17:00" },
        TIME_ZONE,
      ),
    ).toEqual({
      dueDate: "2026-08-21",
      dueTime: "17:00",
      dueAt: "2026-08-22T00:00:00.000Z",
    });
    expect(
      deadlineUpdateFields({ dueDate: "2026-08-21" }, TIME_ZONE),
    ).toEqual({
      dueDate: "2026-08-21",
      dueTime: undefined,
      dueAt: undefined,
    });
  });

  it("keeps the manual slot exact while flexible work replans around it", () => {
    const manualTask = task({
      id: "manual",
      title: "Manual decision",
      estimatedMinutes: 45,
      dueAt: "2026-07-27T08:30:00.000Z",
    });
    const flexibleTask = task({
      id: "flexible",
      title: "Flexible follow-up",
      estimatedMinutes: 45,
    });
    const moved = manuallyPlacedSession(
      session({
        start: "2026-07-27T09:00:00.000Z",
        end: "2026-07-27T09:45:00.000Z",
      }),
      "2026-07-27T08:00:00.000Z",
    );

    const proposal = generateSchedule(
      scheduling([manualTask, flexibleTask], {
        availability: [
          {
            start: "2026-07-27T08:00:00.000Z",
            end: "2026-07-27T10:00:00.000Z",
          },
        ],
        lockedSessions: [
          {
            id: moved.id,
            taskId: moved.taskId,
            title: moved.title,
            start: moved.start,
            end: moved.end,
            locked: true,
            status: "proposed",
          },
        ],
      }),
    );

    expect(
      proposal.sessions.filter((item) => item.taskId === "manual"),
    ).toHaveLength(1);
    expect(
      proposal.sessions.find((item) => item.taskId === "manual"),
    ).toMatchObject({
      start: "2026-07-27T08:00:00.000Z",
      end: "2026-07-27T08:45:00.000Z",
      locked: true,
    });
    const replanned = proposal.sessions.find(
      (item) => item.taskId === "flexible",
    );
    expect(replanned).toBeDefined();
    expect(new Date(replanned?.start ?? 0).getTime()).toBeGreaterThanOrEqual(
      new Date(moved.end).getTime(),
    );
    expect(proposal.planHealth.deadlinesAtRisk).toBe(1);
    expect(proposal.planHealth.summary).toContain("confirmed work extends past");
  });

  it("reflows a full 250-task workspace in under one second", () => {
    const base = new Date("2026-07-27T08:00:00.000Z").getTime();
    const manyTasks = Array.from({ length: 250 }, (_, index) =>
      task({
        id: `perf-${index}`,
        title: `Responsibility ${index + 1}`,
        estimatedMinutes: 45,
      }),
    );
    const existing = manyTasks.map<PlannedSession>((item, index) => {
      const start = base + index * 60 * 60_000;
      return {
        id: `session-${item.id}`,
        taskId: item.id!,
        title: item.title,
        start: new Date(start).toISOString(),
        end: new Date(start + 45 * 60_000).toISOString(),
        minutes: 45,
        status: "proposed",
        locked: false,
        reasonCodes: ["EARLY_COMPLETION"],
        explanation: "Existing stable placement.",
      };
    });
    const moved = manuallyPlacedSession(existing[0], existing[125].start);
    const started = performance.now();
    const preserved = sessionsForManualPlacementReflow(
      existing,
      manyTasks,
      moved,
    );
    const proposal = generateSchedule(
      scheduling(manyTasks, {
        windowStart: new Date(base).toISOString(),
        windowEnd: new Date(base + 30 * 24 * 60 * 60_000).toISOString(),
        availability: [
          {
            start: new Date(base).toISOString(),
            end: new Date(base + 30 * 24 * 60 * 60_000).toISOString(),
          },
        ],
        lockedSessions: preserved.map((item) => ({
          id: item.id,
          taskId: item.taskId,
          title: item.title,
          start: item.start,
          end: item.end,
          locked: item.locked,
          status: item.status === "in_progress" ? "approved" : item.status,
        })),
      }),
    );

    expect(performance.now() - started).toBeLessThan(1_000);
    expect(preserved).toHaveLength(249);
    expect(proposal.sessions).toHaveLength(250);
    expect(proposal.sessions.find((item) => item.id === moved.id)).toMatchObject({
      start: moved.start,
      end: moved.end,
      locked: true,
    });
  }, 10_000);
});
