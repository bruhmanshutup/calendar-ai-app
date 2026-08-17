import { addDays, format, parseISO } from "date-fns";
import { fromZonedTime } from "date-fns-tz";
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES } from "../lib/defaults";
import { generateSchedule } from "../lib/domain/scheduler";
import type { ExtractionInput } from "../lib/domain/types";
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
