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
    expect(proposal.planHealth.deadlinesAtRisk).toBe(1);
    expect(proposal.planHealth.summary).toContain("1 overdue deadline is still at risk");
  });

  it("does not double-count overdue work that also has unplaced time", () => {
    const proposal = generateSchedule(
      scheduling(
        [
          task({
            id: "overdue-unplaced",
            title: "Overdue work with time left",
            dueDate: "2026-07-26",
            estimatedMinutes: 90,
            priority: "urgent",
          }),
        ],
        {
          availability: [
            { start: "2026-07-27T08:00:00.000Z", end: "2026-07-27T08:45:00.000Z" },
          ],
        },
      ),
    );

    expect(proposal.unschedulable).toHaveLength(1);
    expect(proposal.planHealth.deadlinesAtRisk).toBe(1);
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

  it("starts inside the recurrence window and preserves alternating rest days", () => {
    const availability = [
      "2026-07-27",
      "2026-07-28",
      "2026-07-29",
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
      "2026-08-02",
    ].map((date) => ({
      start: `${date}T08:00:00.000Z`,
      end: `${date}T20:00:00.000Z`,
    }));
    const proposal = generateSchedule(
      scheduling(
        [
          task({
            id: "alternating-workout",
            title: "Work out",
            taskType: "recurring_goal",
            category: "fitness",
            estimatedMinutes: 60,
            minimumSessionMinutes: 30,
            recurrence: {
              frequency: "daily",
              mode: "quota",
              interval: 2,
              count: 3,
              windowStart: "2026-07-28T00:00:00.000Z",
              windowEnd: "2026-08-02T23:59:59.000Z",
            },
          }),
        ],
        {
          windowEnd: "2026-08-02T23:59:59.000Z",
          availability,
        },
      ),
    );
    const dates = proposal.sessions
      .filter((session) => session.taskId === "alternating-workout")
      .map((session) => session.start.slice(0, 10));

    expect(dates).toEqual(["2026-07-28", "2026-07-30", "2026-08-01"]);
    expect(proposal.unschedulable).toHaveLength(0);
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

  it("supports multiple occurrences per day and a replacement-day schedule", () => {
    const dates = [
      "2026-07-27",
      "2026-07-28",
      "2026-07-29",
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
      "2026-08-02",
    ];
    const proposal = generateSchedule(
      scheduling(
        [
          task({
            id: "twice-daily",
            title: "Take medication",
            taskType: "recurring_goal",
            estimatedMinutes: 15,
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
                    "tuesday",
                    "wednesday",
                    "thursday",
                    "friday",
                    "saturday",
                  ],
                  time: "08:00",
                },
                {
                  daysOfWeek: [
                    "monday",
                    "tuesday",
                    "wednesday",
                    "thursday",
                    "friday",
                    "saturday",
                  ],
                  time: "20:00",
                },
                { daysOfWeek: ["sunday"], time: "09:00" },
              ],
            },
          }),
        ],
        {
          windowEnd: "2026-08-02T23:00:00.000Z",
          availability: dates.map((date) => ({
            start: `${date}T07:00:00.000Z`,
            end: `${date}T21:00:00.000Z`,
          })),
        },
      ),
    );
    const sessions = proposal.sessions.filter(
      (session) => session.taskId === "twice-daily",
    );

    expect(sessions).toHaveLength(13);
    expect(
      sessions.filter((session) => session.start.startsWith("2026-08-02"))
        .map((session) => session.start),
    ).toEqual(["2026-08-02T09:00:00.000Z"]);
  });

  it("applies one-date replacements and skips without changing later weeks", () => {
    const dates = [
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
      "2026-08-13",
      "2026-08-14",
    ];
    const proposal = generateSchedule(
      scheduling(
        [
          task({
            id: "date-exceptions",
            title: "Daily routine",
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
                    "tuesday",
                    "wednesday",
                    "thursday",
                    "friday",
                    "saturday",
                    "sunday",
                  ],
                  time: "09:00",
                },
              ],
              dateOverrides: [
                { date: "2026-08-12", times: ["11:00"] },
                { date: "2026-08-13", skip: true },
              ],
            },
          }),
        ],
        {
          windowStart: "2026-08-10T00:00:00.000Z",
          windowEnd: "2026-08-15T00:00:00.000Z",
          availability: dates.map((date) => ({
            start: `${date}T07:00:00.000Z`,
            end: `${date}T13:00:00.000Z`,
          })),
        },
      ),
    );
    const starts = proposal.sessions
      .filter((session) => session.taskId === "date-exceptions")
      .map((session) => session.start);

    expect(starts).toEqual([
      "2026-08-10T09:00:00.000Z",
      "2026-08-11T09:00:00.000Z",
      "2026-08-12T11:00:00.000Z",
      "2026-08-14T09:00:00.000Z",
    ]);
  });

  it("uses the explicit anchor for every-other-day schedules", () => {
    const dates = [
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
      "2026-08-13",
      "2026-08-14",
      "2026-08-15",
      "2026-08-16",
    ];
    const proposal = generateSchedule(
      scheduling(
        [
          task({
            id: "alternating",
            title: "Water plants",
            taskType: "recurring_goal",
            estimatedMinutes: 15,
            recurrence: {
              frequency: "daily",
              mode: "fixed_times",
              interval: 2,
              anchorDate: "2026-08-10",
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
                { daysOfWeek: [
                  "monday",
                  "tuesday",
                  "wednesday",
                  "thursday",
                  "friday",
                  "saturday",
                  "sunday",
                ], time: "08:00" },
              ],
            },
          }),
        ],
        {
          windowStart: "2026-08-10T00:00:00.000Z",
          windowEnd: "2026-08-17T00:00:00.000Z",
          availability: dates.map((date) => ({
            start: `${date}T07:00:00.000Z`,
            end: `${date}T10:00:00.000Z`,
          })),
        },
      ),
    );

    expect(
      proposal.sessions
        .filter((session) => session.taskId === "alternating")
        .map((session) => session.start.slice(0, 10)),
    ).toEqual(["2026-08-10", "2026-08-12", "2026-08-14", "2026-08-16"]);
  });

  it("honors an explicit early routine outside preferred waking hours", () => {
    const dates = [
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
      "2026-08-13",
      "2026-08-14",
      "2026-08-15",
      "2026-08-16",
    ];
    const workout = task({
      id: "early-alternating-workout",
      title: "Work out",
      taskType: "recurring_goal",
      category: "fitness",
      estimatedMinutes: 60,
      recurrence: {
        frequency: "daily",
        mode: "fixed_times",
        interval: 2,
        anchorDate: "2026-08-10",
        daysOfWeek: [
          "monday",
          "tuesday",
          "wednesday",
          "thursday",
          "friday",
          "saturday",
          "sunday",
        ],
        timeRules: [{
          daysOfWeek: [
            "monday",
            "tuesday",
            "wednesday",
            "thursday",
            "friday",
            "saturday",
            "sunday",
          ],
          time: "06:00",
        }],
      },
    });
    const basePatch = {
      windowStart: "2026-08-10T00:00:00.000Z",
      windowEnd: "2026-08-17T00:00:00.000Z",
      allowExplicitTimesOutsideAvailability: true,
      availability: dates.map((date) => ({
        start: `${date}T07:00:00.000Z`,
        end: `${date}T23:00:00.000Z`,
      })),
    };
    const proposal = generateSchedule(scheduling([workout], basePatch));

    expect(
      proposal.sessions.map((session) => session.start),
    ).toEqual([
      "2026-08-10T06:00:00.000Z",
      "2026-08-12T06:00:00.000Z",
      "2026-08-14T06:00:00.000Z",
      "2026-08-16T06:00:00.000Z",
    ]);
    expect(proposal.unschedulable).toHaveLength(0);

    const withCalendarConflict = generateSchedule(
      scheduling([workout], {
        ...basePatch,
        unavailableEvents: [{
          start: "2026-08-12T06:00:00.000Z",
          end: "2026-08-12T07:00:00.000Z",
        }],
      }),
    );
    expect(withCalendarConflict.sessions).toHaveLength(3);
    expect(withCalendarConflict.unschedulable[0]).toMatchObject({
      reasonCode: "FIXED_TIME_CONFLICT",
      unscheduledMinutes: 60,
    });
  });

  it("stops a fixed recurrence at its explicit occurrence limit", () => {
    const dates = ["2026-08-10", "2026-08-11", "2026-08-12"];
    const proposal = generateSchedule(
      scheduling(
        [
          task({
            id: "limited-routine",
            title: "Limited routine",
            taskType: "recurring_goal",
            estimatedMinutes: 15,
            recurrence: {
              frequency: "daily",
              mode: "fixed_times",
              occurrenceLimit: 3,
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
                    "tuesday",
                    "wednesday",
                    "thursday",
                    "friday",
                    "saturday",
                    "sunday",
                  ],
                  time: "08:00",
                },
                {
                  daysOfWeek: [
                    "monday",
                    "tuesday",
                    "wednesday",
                    "thursday",
                    "friday",
                    "saturday",
                    "sunday",
                  ],
                  time: "20:00",
                },
              ],
            },
          }),
        ],
        {
          windowStart: "2026-08-10T00:00:00.000Z",
          windowEnd: "2026-08-13T00:00:00.000Z",
          availability: dates.map((date) => ({
            start: `${date}T07:00:00.000Z`,
            end: `${date}T21:00:00.000Z`,
          })),
        },
      ),
    );

    expect(
      proposal.sessions
        .filter((session) => session.taskId === "limited-routine")
        .map((session) => session.start),
    ).toEqual([
      "2026-08-10T08:00:00.000Z",
      "2026-08-10T20:00:00.000Z",
      "2026-08-11T08:00:00.000Z",
    ]);
  });

  it("schedules monthly dates and ordinal weekdays without moving invalid dates", () => {
    const availability = [
      "2026-08-03",
      "2026-08-28",
      "2026-08-31",
      "2026-09-07",
      "2026-09-25",
    ].map((date) => ({
      start: `${date}T07:00:00.000Z`,
      end: `${date}T19:00:00.000Z`,
    }));
    const proposal = generateSchedule(
      scheduling(
        [
          task({
            id: "month-31",
            title: "Month-end task",
            taskType: "recurring_goal",
            estimatedMinutes: 30,
            recurrence: {
              frequency: "monthly",
              mode: "fixed_times",
              monthlyRules: [
                { type: "days_of_month", daysOfMonth: [31], times: ["09:00"] },
              ],
            },
          }),
          task({
            id: "first-monday",
            title: "First Monday task",
            taskType: "recurring_goal",
            estimatedMinutes: 30,
            recurrence: {
              frequency: "monthly",
              mode: "fixed_times",
              monthlyRules: [
                {
                  type: "ordinal_weekday",
                  ordinal: 1,
                  dayOfWeek: "monday",
                  times: ["10:00"],
                },
              ],
            },
          }),
          task({
            id: "last-friday",
            title: "Last Friday task",
            taskType: "recurring_goal",
            estimatedMinutes: 30,
            recurrence: {
              frequency: "monthly",
              mode: "fixed_times",
              monthlyRules: [
                {
                  type: "ordinal_weekday",
                  ordinal: -1,
                  dayOfWeek: "friday",
                  times: ["17:00"],
                },
              ],
            },
          }),
        ],
        {
          windowStart: "2026-08-01T00:00:00.000Z",
          windowEnd: "2026-10-01T00:00:00.000Z",
          availability,
        },
      ),
    );

    expect(
      proposal.sessions
        .filter((session) => session.taskId === "month-31")
        .map((session) => session.start),
    ).toEqual(["2026-08-31T09:00:00.000Z"]);
    expect(
      proposal.sessions
        .filter((session) => session.taskId === "first-monday")
        .map((session) => session.start),
    ).toEqual([
      "2026-08-03T10:00:00.000Z",
      "2026-09-07T10:00:00.000Z",
    ]);
    expect(
      proposal.sessions
        .filter((session) => session.taskId === "last-friday")
        .map((session) => session.start),
    ).toEqual([
      "2026-08-28T17:00:00.000Z",
      "2026-09-25T17:00:00.000Z",
    ]);
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

  it("preserves committed work and schedules only the remaining task time", () => {
    const committed = {
      id: "session-work-1",
      taskId: "work",
      title: "Work",
      start: "2026-07-27T10:00:00.000Z",
      end: "2026-07-27T10:30:00.000Z",
      locked: true,
      status: "approved" as const,
    };
    const proposal = generateSchedule(
      scheduling(
        [
          task({
            id: "work",
            title: "Work",
            estimatedMinutes: 60,
            splittable: true,
          }),
        ],
        { lockedSessions: [committed] },
      ),
    );

    const workSessions = proposal.sessions.filter(
      (session) => session.taskId === "work",
    );
    expect(workSessions).toHaveLength(2);
    expect(workSessions.reduce((total, session) => total + session.minutes, 0)).toBe(
      60,
    );
    expect(workSessions.map((session) => session.id)).toEqual([
      "session-work-1",
      "session-work-1-v2",
    ]);
  });

  it("does not duplicate a preserved fixed-time responsibility", () => {
    const fixed = task({
      id: "appointment",
      title: "Appointment",
      taskType: "fixed_time",
      fixedStartAt: "2026-07-27T10:00:00.000Z",
      fixedEndAt: "2026-07-27T10:30:00.000Z",
      estimatedMinutes: 30,
    });
    const proposal = generateSchedule(
      scheduling([fixed], {
        lockedSessions: [
          {
            id: "session-appointment-1",
            taskId: "appointment",
            title: "Appointment",
            start: fixed.fixedStartAt!,
            end: fixed.fixedEndAt!,
            locked: true,
            status: "approved",
          },
        ],
      }),
    );

    expect(
      proposal.sessions.filter((session) => session.taskId === "appointment"),
    ).toHaveLength(1);
    expect(proposal.unschedulable).toEqual([]);
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
