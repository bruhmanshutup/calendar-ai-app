import { describe, expect, it } from "vitest";
import { generateSchedule } from "../lib/domain/scheduler";
import type { TimeInterval } from "../lib/domain/types";
import { scheduling, task, TEST_PREFERENCES } from "./fixtures";

function overlaps(a: TimeInterval, b: TimeInterval): boolean {
  return new Date(a.start) < new Date(b.end) && new Date(b.start) < new Date(a.end);
}

describe("deterministic scheduling", () => {
  it("never schedules after a deadline", () => {
    const dueAt = "2026-07-27T11:00:00.000Z";
    const proposal = generateSchedule(
      scheduling([
        task({
          id: "deadline",
          title: "Deadline task",
          dueDate: "2026-07-27",
          dueAt,
          estimatedMinutes: 90,
          splittable: true,
        }),
      ]),
    );
    expect(
      proposal.sessions
        .filter((session) => session.taskId === "deadline")
        .every((session) => new Date(session.end) <= new Date(dueAt)),
    ).toBe(true);
  });

  it("places overdue work in the earliest valid opening", () => {
    const proposal = generateSchedule(
      scheduling([
        task({
          id: "overdue",
          title: "Overdue orientation task",
          dueDate: "2026-07-26",
          estimatedMinutes: 45,
          priority: "urgent",
        }),
      ]),
    );
    const session = proposal.sessions.find((item) => item.taskId === "overdue");

    expect(session?.start).toBe("2026-07-27T08:00:00.000Z");
    expect(session?.reasonCodes).toContain("OVERDUE_RECOVERY");
    expect(proposal.unschedulable).toHaveLength(0);
  });

  it("schedules overdue work before future work when capacity is tight", () => {
    const proposal = generateSchedule(
      scheduling(
        [
          task({
            id: "future",
            title: "Future task",
            dueDate: "2026-07-31",
            estimatedMinutes: 45,
          }),
          task({
            id: "overdue-first",
            title: "Overdue task",
            dueDate: "2026-07-26",
            estimatedMinutes: 45,
            priority: "urgent",
          }),
        ],
        {
          availability: [
            { start: "2026-07-27T08:00:00.000Z", end: "2026-07-27T09:30:00.000Z" },
          ],
        },
      ),
    );

    expect(proposal.sessions.map((session) => session.taskId)).toContain(
      "overdue-first",
    );
    expect(proposal.sessions.map((session) => session.taskId)).not.toContain(
      "future",
    );
  });

  it("distributes same-deadline tasks across reasonable days", () => {
    const tasks = Array.from({ length: 6 }, (_, index) =>
      task({
        id: `august-task-${index + 1}`,
        title: `August task ${index + 1}`,
        dueDate: "2026-07-31",
        estimatedMinutes: 45,
      }),
    );
    const proposal = generateSchedule(scheduling(tasks));
    const dates = new Set(
      proposal.sessions
        .filter((session) => session.taskId.startsWith("august-task-"))
        .map((session) => session.start.slice(0, 10)),
    );

    expect(dates.size).toBeGreaterThanOrEqual(3);
    expect(proposal.unschedulable).toHaveLength(0);
  });

  it("respects waking and sleeping boundaries", () => {
    const proposal = generateSchedule(
      scheduling(
        [task({ id: "sleep", title: "Sleep-safe task" })],
        {
          availability: [
            { start: "2026-07-27T01:00:00.000Z", end: "2026-07-27T04:00:00.000Z" },
            { start: "2026-07-27T08:00:00.000Z", end: "2026-07-27T10:00:00.000Z" },
          ],
        },
      ),
    );
    const session = proposal.sessions.find((item) => item.taskId === "sleep");
    expect(session).toBeDefined();
    expect(new Date(session!.start).getTime()).toBeGreaterThanOrEqual(
      new Date("2026-07-27T08:00:00.000Z").getTime(),
    );
    expect(new Date(session!.end).getTime()).toBeLessThanOrEqual(
      new Date("2026-07-27T10:00:00.000Z").getTime(),
    );
  });

  it.each([
    ["manually blocked time", "blockedTimes"],
    ["calendar events", "unavailableEvents"],
  ] as const)("respects %s", (_label, key) => {
    const blocked = {
      start: "2026-07-27T08:00:00.000Z",
      end: "2026-07-27T10:00:00.000Z",
    };
    const proposal = generateSchedule(
      scheduling(
        [task({ id: key, title: key })],
        { [key]: [blocked] },
      ),
    );
    const session = proposal.sessions.find((item) => item.taskId === key);
    expect(session).toBeDefined();
    expect(overlaps(session!, blocked)).toBe(false);
  });

  it("does not create overlapping sessions", () => {
    const proposal = generateSchedule(
      scheduling([
        task({ id: "one", title: "One", estimatedMinutes: 90 }),
        task({ id: "two", title: "Two", estimatedMinutes: 90 }),
        task({ id: "three", title: "Three", estimatedMinutes: 90 }),
      ]),
    );
    for (let index = 0; index < proposal.sessions.length; index += 1) {
      for (let other = index + 1; other < proposal.sessions.length; other += 1) {
        expect(overlaps(proposal.sessions[index], proposal.sessions[other])).toBe(false);
      }
    }
  });

  it("splits long work without tiny leftover blocks", () => {
    const proposal = generateSchedule(
      scheduling([
        task({
          id: "long",
          title: "Long task",
          estimatedMinutes: 140,
          splittable: true,
          minimumSessionMinutes: 30,
        }),
      ]),
    );
    const sessions = proposal.sessions.filter((session) => session.taskId === "long");
    expect(sessions.length).toBeGreaterThan(1);
    expect(sessions.every((session) => session.minutes >= 30)).toBe(true);
    expect(sessions.reduce((sum, session) => sum + session.minutes, 0)).toBe(140);
  });

  it("adds breaks after demanding focus sessions", () => {
    const proposal = generateSchedule(
      scheduling([
        task({
          id: "focus",
          title: "Demanding focus",
          energyDemand: "high",
          estimatedMinutes: 90,
          splittable: true,
        }),
      ]),
    );
    expect(proposal.breaks.length).toBeGreaterThan(0);
    expect(proposal.breaks.every((item) => item.minutes === 10)).toBe(true);
  });

  it("spreads recurring sessions across available days", () => {
    const proposal = generateSchedule(
      scheduling(
        [
          task({
            id: "routine",
            title: "Routine",
            taskType: "recurring_goal",
            category: "fitness",
            estimatedMinutes: 45,
            recurrence: {
              frequency: "weekly",
              count: 3,
              windowEnd: "2026-07-30T21:00:00.000Z",
            },
          }),
        ],
        {
          availability: [
            { start: "2026-07-27T17:00:00.000Z", end: "2026-07-27T20:00:00.000Z" },
            { start: "2026-07-28T17:00:00.000Z", end: "2026-07-28T20:00:00.000Z" },
            { start: "2026-07-29T17:00:00.000Z", end: "2026-07-29T20:00:00.000Z" },
          ],
        },
      ),
    );
    const dates = new Set(
      proposal.sessions
        .filter((session) => session.taskId === "routine")
        .map((session) => session.start.slice(0, 10)),
    );
    expect(dates.size).toBe(3);
  });

  it("never places the same recurring goal twice on one day", () => {
    const proposal = generateSchedule(
      scheduling(
        [
          task({
            id: "daily-limit",
            title: "Go to the gym",
            taskType: "recurring_goal",
            category: "fitness",
            estimatedMinutes: 45,
            recurrence: {
              frequency: "weekly",
              count: 3,
              windowEnd: "2026-07-28T20:00:00.000Z",
            },
          }),
        ],
        {
          availability: [
            { start: "2026-07-27T17:00:00.000Z", end: "2026-07-27T20:00:00.000Z" },
            { start: "2026-07-28T17:00:00.000Z", end: "2026-07-28T20:00:00.000Z" },
          ],
        },
      ),
    );
    const sessions = proposal.sessions.filter(
      (session) => session.taskId === "daily-limit",
    );
    const dates = sessions.map((session) => session.start.slice(0, 10));

    expect(sessions).toHaveLength(2);
    expect(new Set(dates).size).toBe(sessions.length);
    expect(proposal.unschedulable[0]?.unscheduledMinutes).toBe(45);
  });

  it("expands a split daily recurrence at its exact per-day times", () => {
    const availability = [
      "2026-07-27",
      "2026-07-28",
      "2026-07-29",
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
    ].map((date) => ({
      start: `${date}T07:00:00.000Z`,
      end: `${date}T14:00:00.000Z`,
    }));
    const proposal = generateSchedule(
      scheduling(
        [
          task({
            id: "split-routine",
            title: "Take medication",
            taskType: "recurring_goal",
            estimatedMinutes: 30,
            recurrence: {
              frequency: "daily",
              mode: "fixed_times",
              daysOfWeek: [
                "monday",
                "tuesday",
                "wednesday",
                "thursday",
                "friday",
                "saturday",
                "sunday",
              ],
              timeRules: [
                {
                  daysOfWeek: [
                    "monday",
                    "wednesday",
                    "friday",
                    "saturday",
                    "sunday",
                  ],
                  time: "09:00",
                },
                {
                  daysOfWeek: ["tuesday", "thursday"],
                  time: "11:00",
                },
              ],
            },
          }),
        ],
        { availability },
      ),
    );
    const sessions = proposal.sessions.filter(
      (session) => session.taskId === "split-routine",
    );

    expect(sessions.map((session) => session.start)).toEqual([
      "2026-07-27T09:00:00.000Z",
      "2026-07-28T11:00:00.000Z",
      "2026-07-29T09:00:00.000Z",
      "2026-07-30T11:00:00.000Z",
      "2026-07-31T09:00:00.000Z",
      "2026-08-01T09:00:00.000Z",
    ]);
    expect(sessions.every((session) => session.locked)).toBe(true);
    expect(sessions.every((session) => session.reasonCodes.includes("FIXED_TIME"))).toBe(true);
    expect(proposal.unschedulable).toHaveLength(0);
  });

  it("retains the configured buffer", () => {
    const proposal = generateSchedule(
      scheduling(
        [
          task({
            id: "large",
            title: "Large workload",
            estimatedMinutes: 600,
            splittable: true,
          }),
        ],
        {
          availability: [
            { start: "2026-07-27T08:00:00.000Z", end: "2026-07-27T18:00:00.000Z" },
          ],
        },
      ),
    );
    expect(proposal.bufferMinutes).toBeGreaterThanOrEqual(90);
    expect(proposal.plannedMinutes).toBeLessThanOrEqual(510);
  });

  it("is stable for the same normalized input", () => {
    const input = scheduling([
      task({ id: "a", title: "A", estimatedMinutes: 120, splittable: true }),
      task({ id: "b", title: "B", priority: "high" }),
    ]);
    expect(generateSchedule(input)).toEqual(generateSchedule(input));
  });

  it("returns structured and actionable overload explanations", () => {
    const proposal = generateSchedule(
      scheduling(
        [task({ id: "overload", title: "Overload", estimatedMinutes: 240, splittable: true })],
        {
          availability: [
            { start: "2026-07-27T08:00:00.000Z", end: "2026-07-27T09:00:00.000Z" },
          ],
        },
      ),
    );
    expect(proposal.unschedulable[0]).toMatchObject({
      taskId: "overload",
      reasonCode: "INSUFFICIENT_CAPACITY",
    });
    expect(proposal.unschedulable[0].suggestedActions.length).toBeGreaterThan(0);
  });

  it("preserves locked sessions exactly", () => {
    const locked = {
      id: "locked",
      taskId: "locked-task",
      title: "Locked",
      start: "2026-07-27T10:00:00.000Z",
      end: "2026-07-27T10:45:00.000Z",
      locked: true,
      status: "approved" as const,
    };
    const proposal = generateSchedule(
      scheduling([task({ id: "new", title: "New" })], {
        lockedSessions: [locked],
      }),
    );
    expect(proposal.sessions.find((session) => session.id === "locked")).toMatchObject({
      start: locked.start,
      end: locked.end,
      locked: true,
    });
  });

  it("rejects minimum sessions larger than the configured maximum", () => {
    const proposal = generateSchedule(
      scheduling([
        task({
          id: "minimum",
          title: "Minimum too large",
          estimatedMinutes: 120,
          minimumSessionMinutes: 120,
          splittable: true,
        }),
      ]),
    );
    expect(proposal.unschedulable[0].reasonCode).toBe(
      "MINIMUM_SESSION_TOO_LARGE",
    );
  });

  it("enforces weekend restrictions", () => {
    const proposal = generateSchedule(
      scheduling(
        [task({ id: "weekend", title: "Weekend" })],
        {
          preferences: { ...TEST_PREFERENCES, weekendsAllowed: false },
          availability: [
            { start: "2026-08-01T09:00:00.000Z", end: "2026-08-01T12:00:00.000Z" },
          ],
        },
      ),
    );
    expect(proposal.sessions.filter((session) => session.taskId === "weekend")).toHaveLength(0);
  });
});
