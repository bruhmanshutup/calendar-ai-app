import { addDays, format } from "date-fns";
import { fromZonedTime } from "date-fns-tz";
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES } from "../lib/defaults";
import { generateSchedule } from "../lib/domain/scheduler";
import type { ExtractionInput, ExtractionResult } from "../lib/domain/types";
import { recoverFlexibleRecurrences } from "../lib/providers/flexible-recurrence-recovery";
import { recoverConcreteFormattedTasks } from "../lib/providers/format-recovery";
import { MockTaskExtractionProvider } from "../lib/providers/mock-extraction";
import { recoverExplicitOverdueTasks } from "../lib/providers/overdue-recovery";
import { recoverTimedRecurrences } from "../lib/providers/recurrence-recovery";
import {
  prepareStructuredPlanExtractionInput,
  recoverStructuredLearningPlan,
} from "../lib/providers/structured-plan-recovery";
import { task } from "./fixtures";

const CURRENT_DATE = "2026-08-12";

function representativeLargePlan(): string {
  return Array.from({ length: 12 }, (_, weekIndex) => {
    const week = weekIndex + 1;
    const checklist = Array.from(
      { length: 5 },
      (_, dayIndex) =>
        `- Day ${dayIndex + 1}: Complete electronics cooling practice ${week}.${dayIndex + 1}, record the result, and summarize what changed.`,
    ).join("\n");
    return `Week ${week} - Electronics Cooling Topic ${week}
Goal: Build practical intuition for heat transfer, airflow, simulation, and design tradeoffs.
Tutorial links:
MIT OpenCourseWare - https://ocw.mit.edu/courses/2-051-introduction-to-heat-transfer-fall-2015/
LearnChemE - https://learncheme.com/screencasts/heat-transfer/
Daily checklist:
${checklist}`;
  }).join("\n");
}

async function extractLikeRoute(input: ExtractionInput): Promise<ExtractionResult> {
  const prepared = prepareStructuredPlanExtractionInput(input);
  let result = await new MockTaskExtractionProvider().extractTasks(prepared);
  result = await recoverExplicitOverdueTasks(input, result);
  result = await recoverTimedRecurrences(input, result);
  result = await recoverFlexibleRecurrences(input, result);
  result = await recoverConcreteFormattedTasks(input, result);
  return recoverStructuredLearningPlan(input, result);
}

function availabilityForDays(days: number) {
  return Array.from({ length: days }, (_, index) => {
    const date = format(addDays(new Date(`${CURRENT_DATE}T12:00:00Z`), index), "yyyy-MM-dd");
    return {
      start: fromZonedTime(
        `${date}T${DEFAULT_PREFERENCES.wakingTime}:00`,
        DEFAULT_PREFERENCES.timeZone,
      ).toISOString(),
      end: fromZonedTime(
        `${date}T${DEFAULT_PREFERENCES.sleepingTime}:00`,
        DEFAULT_PREFERENCES.timeZone,
      ).toISOString(),
    };
  });
}

describe("large responsibility imports", () => {
  it("keeps all 60 checklist responsibilities from a long structured plan", async () => {
    const input: ExtractionInput = {
      text: representativeLargePlan(),
      currentLocalDate: CURRENT_DATE,
      timeZone: DEFAULT_PREFERENCES.timeZone,
    };

    const result = await extractLikeRoute(input);

    expect(input.text.length).toBeGreaterThan(8_000);
    expect(result.tasks).toHaveLength(60);
    expect(result.tasks[0].title).toContain("Week 1, Day 1");
    expect(result.tasks.at(-1)?.title).toContain("Week 12, Day 5");
  });

  it("schedules a 12-week plan without an unbounded main-thread calculation", async () => {
    const input: ExtractionInput = {
      text: representativeLargePlan(),
      currentLocalDate: CURRENT_DATE,
      timeZone: DEFAULT_PREFERENCES.timeZone,
    };
    const result = await extractLikeRoute(input);
    const availability = availabilityForDays(90);
    const started = performance.now();

    const proposal = generateSchedule({
      windowStart: availability[0].start,
      windowEnd: availability.at(-1)!.end,
      tasks: result.tasks,
      preferences: DEFAULT_PREFERENCES,
      availability,
      unavailableEvents: [],
      blockedTimes: [],
      lockedSessions: [],
    });

    expect(performance.now() - started).toBeLessThan(1_000);
    expect(proposal.sessions.length + proposal.unschedulable.length).toBeGreaterThan(0);
  }, 10_000);

  it("schedules the supported 250-task workspace in under one second", () => {
    const tasks = Array.from({ length: 250 }, (_, index) =>
      task({
        id: `max-workspace-${index}`,
        title: `Workspace responsibility ${index + 1}`,
        estimatedMinutes: 90,
      }),
    );
    const availability = availabilityForDays(120);
    const started = performance.now();

    const proposal = generateSchedule({
      windowStart: availability[0].start,
      windowEnd: availability.at(-1)!.end,
      tasks,
      preferences: DEFAULT_PREFERENCES,
      availability,
      unavailableEvents: [],
      blockedTimes: [],
      lockedSessions: [],
    });

    expect(performance.now() - started).toBeLessThan(1_000);
    expect(proposal.sessions).toHaveLength(250);
    expect(proposal.unschedulable).toEqual([]);
  }, 10_000);

  it("keeps sparse weekly availability reachable on the large-workspace path", () => {
    const tasks = Array.from({ length: 100 }, (_, index) =>
      task({
        id: `weekly-workspace-${index}`,
        title: `Weekly-window responsibility ${index + 1}`,
        estimatedMinutes: 90,
      }),
    );
    const availability = Array.from({ length: 18 }, (_, index) => {
      const date = format(
        addDays(new Date(`${CURRENT_DATE}T12:00:00Z`), index * 7),
        "yyyy-MM-dd",
      );
      return {
        start: fromZonedTime(
          `${date}T${DEFAULT_PREFERENCES.wakingTime}:00`,
          DEFAULT_PREFERENCES.timeZone,
        ).toISOString(),
        end: fromZonedTime(
          `${date}T${DEFAULT_PREFERENCES.sleepingTime}:00`,
          DEFAULT_PREFERENCES.timeZone,
        ).toISOString(),
      };
    });

    const proposal = generateSchedule({
      windowStart: availability[0].start,
      windowEnd: availability.at(-1)!.end,
      tasks,
      preferences: DEFAULT_PREFERENCES,
      availability,
      unavailableEvents: [],
      blockedTimes: [],
      lockedSessions: [],
    });

    expect(proposal.sessions).toHaveLength(100);
    expect(proposal.unschedulable).toEqual([]);
  });
});
