import { addDays, format, parseISO } from "date-fns";
import { fromZonedTime } from "date-fns-tz";
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES } from "../lib/defaults";
import { generateSchedule } from "../lib/domain/scheduler";
import type { ExtractionInput } from "../lib/domain/types";
import { runExtractionPipeline } from "../lib/providers/extraction-pipeline";
import { shouldUseFastLocalExtraction } from "../lib/providers/extraction-strategy";
import { MockTaskExtractionProvider } from "../lib/providers/mock-extraction";
import { recoverNarrativeSchedulingIntent } from "../lib/providers/narrative-scheduling-recovery";

const text = `Monday (today)
6:00 PM — Email Professor Anderson
6:30 PM — Review group project slides
7:30 PM — Gym
9:00 PM — Physics problem set, session 1
Tuesday
10:00 AM — Call dentist
4:30 PM — Calculus study, session 1
6:30 PM — Group project meeting
8:00 PM — Coding side project, session 1
Wednesday
3:00 PM — Grocery shopping
5:00 PM — Physics problem set, session 2
6:30 PM — Gym
After 8:00 PM — Keep free
Thursday
10:00 AM — Calculus study, session 2
12:00 PM — Clean room
2:00 PM — Coding side project, session 2
3:30 PM — Order contact lenses
5:00 PM onward — Hang out with friends
Friday
11:00 AM — Calculus study, session 3
4:30 PM — Gym
7:00 PM — Coding side project, optional third session
Saturday
9:00 AM — Calculus quiz
5:00 PM — Gym`;

const input: ExtractionInput = {
  text,
  currentLocalDate: "2026-08-17",
  timeZone: "America/Los_Angeles",
};

const fridayInput: ExtractionInput = {
  ...input,
  currentLocalDate: "2026-08-21",
};

describe("weekday-headed agendas", () => {
  it("preserves every explicit day and start time without narrative rewrites", async () => {
    const local = await new MockTaskExtractionProvider().extractTasks(input);
    const result = recoverNarrativeSchedulingIntent(input, local);

    expect(result.tasks).toHaveLength(21);
    expect(result.tasks.every((task) => task.taskType === "fixed_time")).toBe(true);
    expect(result.tasks.every((task) => task.fixedStartAt && task.fixedEndAt)).toBe(true);
    expect(result.tasks.every((task) => !task.dueDate && !task.recurrence)).toBe(true);
    expect(result.tasks.map((task) => task.title)).not.toContain(
      "Study for calculus quiz",
    );

    expect(
      result.tasks.find((task) => task.title === "Email Professor Anderson"),
    ).toMatchObject({
      fixedStartAt: "2026-08-18T01:00:00.000Z",
      fixedEndAt: "2026-08-18T01:30:00.000Z",
      estimatedMinutes: 30,
    });
    expect(
      result.tasks.find((task) => task.title === "Group project meeting"),
    ).toMatchObject({
      fixedStartAt: "2026-08-19T01:30:00.000Z",
    });
    expect(
      result.tasks.find((task) => task.title === "Hang out with friends"),
    ).toMatchObject({
      fixedStartAt: "2026-08-21T00:00:00.000Z",
      fixedEndAt: "2026-08-21T07:00:00.000Z",
      estimatedMinutes: 420,
      reviewRequired: false,
      approved: true,
    });
    expect(
      result.tasks.find((task) => task.title === "Calculus quiz"),
    ).toMatchObject({
      fixedStartAt: "2026-08-22T16:00:00.000Z",
    });
    expect(result.planningRules?.blockedTimes).toEqual([
      {
        start: "2026-08-20T03:00:00.000Z",
        end: "2026-08-20T07:00:00.000Z",
        label: "Protected free time",
      },
    ]);
  });

  it("keeps an explicit agenda on the deterministic path", async () => {
    const local = await new MockTaskExtractionProvider().extractTasks(input);

    expect(shouldUseFastLocalExtraction(input, local)).toBe(true);
  });

  it("uses explicit agenda rows as timing scaffolding after successful AI interpretation", async () => {
    const localProvider = new MockTaskExtractionProvider();
    const deterministic = await localProvider.extractTasks(input);
    const semanticTasks = deterministic.tasks.map((item, index) => ({
      ...item,
      id: `semantic-agenda-${index + 1}`,
      description: index === 0 ? "Send the professor a concise update." : undefined,
      priority: index === 0 ? ("urgent" as const) : item.priority,
      taskType: index % 4 === 0 ? ("fixed_time" as const) : ("flexible" as const),
      fixedStartAt: index % 4 === 0 ? item.fixedStartAt : undefined,
      fixedEndAt: index % 4 === 0 ? item.fixedEndAt : undefined,
      dueDate: index % 4 === 0 ? undefined : "2026-08-23",
      dueTime: index % 4 === 0 ? undefined : "23:59",
      dueAt: undefined,
      occurrenceWindow: index % 4 === 0
        ? undefined
        : {
            start: "2026-08-17T07:00:00.000Z",
            end: "2026-08-24T07:00:00.000Z",
            label: "this week",
            precision: "named_period" as const,
          },
      schedulingConstraints: index % 4 === 0
        ? undefined
        : {
            allowedDateWindows: [
              {
                start: "2026-08-17T07:00:00.000Z",
                end: "2026-08-24T07:00:00.000Z",
                label: "this week",
                precision: "named_period" as const,
              },
            ],
          },
      fieldConfidence: {
        ...item.fieldConfidence,
        taskType: 0.92,
      },
    }));
    const freeLine = "After 8:00 PM — Keep free";
    const semanticProvider = {
      extractTasks: async () => ({
        tasks: [
          ...semanticTasks,
          {
            ...semanticTasks[0],
            id: "duplicate-email",
          },
          {
            ...semanticTasks[0],
            id: "incorrect-free-time-task",
            title: "Keep free",
            sourceText: freeLine,
          },
        ],
        ignoredStatements: [],
        planningRules: {
          blockedTimes: [
            {
              start: "2026-08-20T03:00:00.000Z",
              end: "2026-08-20T06:59:00.000Z",
              label: "Keep free after 8:00 PM",
            },
          ],
        },
      }),
    };

    const output = await runExtractionPipeline(input, {
      semanticProviderName: "gemini",
      semanticProvider,
      localProvider,
    });

    expect(output.extractionMode).toBe("gemini-hybrid");
    expect(output.result.tasks).toHaveLength(21);
    expect(new Set(output.result.tasks.map((item) => item.id)).size).toBe(21);
    expect(output.result.tasks.some((item) => item.title === "Keep free")).toBe(
      false,
    );
    expect(
      output.result.tasks.every(
        (item) =>
          item.taskType === "fixed_time" &&
          Boolean(item.fixedStartAt) &&
          Boolean(item.fixedEndAt) &&
          !item.dueDate &&
          !item.dueTime &&
          !item.occurrenceWindow &&
          !item.schedulingConstraints,
      ),
    ).toBe(true);
    expect(
      output.result.tasks.find(
        (item) => item.title === "Email Professor Anderson",
      ),
    ).toMatchObject({
      id: "semantic-agenda-1",
      fixedStartAt: "2026-08-18T01:00:00.000Z",
      fixedEndAt: "2026-08-18T01:30:00.000Z",
      estimatedMinutes: 30,
      description: "Send the professor a concise update.",
      priority: "urgent",
      approved: true,
      reviewRequired: false,
    });
    expect(
      output.result.tasks.find((item) => item.title === "Hang out with friends"),
    ).toMatchObject({
      fixedStartAt: "2026-08-21T00:00:00.000Z",
      fixedEndAt: "2026-08-21T07:00:00.000Z",
      estimatedMinutes: 420,
    });
    expect(output.result.planningRules?.blockedTimes).toEqual([
      {
        start: "2026-08-20T03:00:00.000Z",
        end: "2026-08-20T07:00:00.000Z",
        label: "Protected free time",
      },
    ]);

    const dates = Array.from({ length: 7 }, (_, index) =>
      format(addDays(parseISO(input.currentLocalDate), index), "yyyy-MM-dd"),
    );
    const availability = dates.map((date) => {
      const nextDate = format(addDays(parseISO(date), 1), "yyyy-MM-dd");
      return {
        start: fromZonedTime(`${date}T08:00:00`, input.timeZone).toISOString(),
        end: fromZonedTime(`${nextDate}T00:00:00`, input.timeZone).toISOString(),
      };
    });
    const proposal = generateSchedule({
      windowStart: availability[0].start,
      windowEnd: availability.at(-1)!.end,
      tasks: output.result.tasks,
      preferences: DEFAULT_PREFERENCES,
      availability,
      unavailableEvents: [],
      blockedTimes: output.result.planningRules?.blockedTimes ?? [],
      lockedSessions: [],
    });

    expect(proposal.unschedulable).toEqual([]);
    expect(proposal.sessions).toHaveLength(21);
    expect(proposal.sessions.map((session) => session.start)).toEqual(
      output.result.tasks
        .map((item) => item.fixedStartAt!)
        .sort((first, second) => first.localeCompare(second)),
    );
  });

  it("keeps weekday headings chronological when a stale today annotation is imported later", async () => {
    const local = await new MockTaskExtractionProvider().extractTasks(fridayInput);
    const result = recoverNarrativeSchedulingIntent(fridayInput, local);

    expect(result.tasks).toHaveLength(21);
    expect(
      result.tasks.find((task) => task.title === "Email Professor Anderson"),
    ).toMatchObject({
      fixedStartAt: "2026-08-25T01:00:00.000Z",
    });
    expect(
      result.tasks.find((task) => task.title === "Call dentist"),
    ).toMatchObject({
      fixedStartAt: "2026-08-25T17:00:00.000Z",
    });
    expect(
      result.tasks.find((task) => task.title === "Grocery shopping"),
    ).toMatchObject({
      fixedStartAt: "2026-08-26T22:00:00.000Z",
    });
    expect(
      result.tasks.find((task) => task.title === "Calculus study, session 2"),
    ).toMatchObject({
      fixedStartAt: "2026-08-27T17:00:00.000Z",
    });
    expect(
      result.tasks.find((task) => task.title === "Calculus study, session 3"),
    ).toMatchObject({
      fixedStartAt: "2026-08-28T18:00:00.000Z",
    });
    expect(
      result.tasks.find((task) => task.title === "Calculus quiz"),
    ).toMatchObject({
      fixedStartAt: "2026-08-29T16:00:00.000Z",
    });
    expect(result.planningRules?.blockedTimes).toEqual([
      {
        start: "2026-08-27T03:00:00.000Z",
        end: "2026-08-27T07:00:00.000Z",
        label: "Protected free time",
      },
    ]);
  });

  it("schedules approved entries at exactly their imported starts", async () => {
    const extracted = await new MockTaskExtractionProvider().extractTasks(input);
    const dates = Array.from({ length: 7 }, (_, index) =>
      format(addDays(parseISO(input.currentLocalDate), index), "yyyy-MM-dd"),
    );
    const availability = dates.map((date) => {
      const nextDate = format(addDays(parseISO(date), 1), "yyyy-MM-dd");
      return {
        start: fromZonedTime(`${date}T08:00:00`, input.timeZone).toISOString(),
        end: fromZonedTime(`${nextDate}T00:00:00`, input.timeZone).toISOString(),
      };
    });
    const proposal = generateSchedule({
      windowStart: availability[0].start,
      windowEnd: availability.at(-1)!.end,
      tasks: extracted.tasks.map((task) => ({
        ...task,
        approved: true,
        reviewRequired: false,
      })),
      preferences: DEFAULT_PREFERENCES,
      availability,
      unavailableEvents: [],
      blockedTimes: extracted.planningRules?.blockedTimes ?? [],
      lockedSessions: [],
    });

    expect(proposal.unschedulable).toEqual([]);
    expect(proposal.sessions).toHaveLength(21);
    expect(proposal.sessions.map((session) => session.start)).toEqual(
      extracted.tasks
        .map((task) => task.fixedStartAt!)
        .sort((first, second) => first.localeCompare(second)),
    );
  });
});
