import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { generateSchedule } from "../lib/domain/scheduler";
import type {
  ExtractedTask,
  PlanningMode,
  SchedulingInput,
  TimeInterval,
} from "../lib/domain/types";
import { scheduling, task, TEST_PREFERENCES } from "./fixtures";

const modes: PlanningMode[] = ["conservative", "balanced", "aggressive"];
const calendarDensities = [0, 1, 2, 3] as const;
const personas = ["home", "remote", "corporate", "banker"] as const;

function overlaps(first: TimeInterval, second: TimeInterval): boolean {
  return new Date(first.start) < new Date(second.end) &&
    new Date(second.start) < new Date(first.end);
}

function workload(
  persona: (typeof personas)[number],
  density: (typeof calendarDensities)[number],
  mode: PlanningMode,
): SchedulingInput {
  const taskCount = {
    home: 9,
    remote: 14,
    corporate: 20,
    banker: 30,
  }[persona];
  const categories: Record<typeof persona, ExtractedTask["category"]> = {
    home: "personal",
    remote: "work",
    corporate: "work",
    banker: "work",
  };
  const estimates = [15, 30, 45, 60, 90];
  const tasks = Array.from({ length: taskCount }, (_, index) => {
    const estimatedMinutes = estimates[(index + density) % estimates.length];
    const day = 27 + Math.min(4, Math.floor(index / 6));
    return task({
      id: `${persona}-${mode}-${density}-${index}`,
      title: `${persona} responsibility ${index + 1}`,
      category: categories[persona],
      priority:
        persona === "banker" && index < 8
          ? "urgent"
          : index % 4 === 0
            ? "high"
            : "medium",
      energyDemand:
        persona === "home" ? "low" : index % 3 === 0 ? "high" : "medium",
      estimatedMinutes,
      dueDate: `2026-07-${String(day).padStart(2, "0")}`,
      splittable: estimatedMinutes > 60,
    });
  });

  if (persona !== "home") {
    tasks.push(
      task({
        id: `${persona}-${mode}-${density}-fixed`,
        title: persona === "banker" ? "Client call" : "Team meeting",
        taskType: "fixed_time",
        fixedStartAt: "2026-07-28T14:00:00.000Z",
        fixedEndAt: "2026-07-28T14:30:00.000Z",
        estimatedMinutes: 30,
      }),
    );
  }

  const unavailableEvents = Array.from({ length: density }, (_, index) => ({
    start: `2026-07-${27 + index}T${10 + index}:00:00.000Z`,
    end: `2026-07-${27 + index}T${12 + index}:00:00.000Z`,
  }));
  if (density >= 2) {
    // Real calendars often contain overlapping holds; these must not shrink
    // capacity twice or let work overlap either hold.
    unavailableEvents.push({
      start: "2026-07-27T11:00:00.000Z",
      end: "2026-07-27T13:00:00.000Z",
    });
  }

  return scheduling(tasks, {
    unavailableEvents,
    preferences: { ...TEST_PREFERENCES, planningMode: mode },
  });
}

const cases = personas.flatMap((persona) =>
  modes.flatMap((mode) =>
    calendarDensities.map((density) => ({ persona, mode, density })),
  ),
);

describe("persona workload scheduling gauntlet", () => {
  it.each(cases)(
    "keeps $persona / $mode / calendar density $density fast and valid",
    ({ persona, mode, density }) => {
      const input = workload(persona, density, mode);
      const started = performance.now();
      const proposal = generateSchedule(input);
      const elapsed = performance.now() - started;

      expect(elapsed).toBeLessThan(250);
      expect(generateSchedule(input)).toEqual(proposal);

      proposal.sessions.forEach((session, index) => {
        proposal.sessions.slice(index + 1).forEach((other) => {
          expect(overlaps(session, other)).toBe(false);
        });
        expect(
          input.availability.some(
            (interval) =>
              new Date(session.start) >= new Date(interval.start) &&
              new Date(session.end) <= new Date(interval.end),
          ),
        ).toBe(true);
        expect(
          input.unavailableEvents.some((event) => overlaps(session, event)),
        ).toBe(false);
      });

      expect(proposal.planHealth.scheduledPercent).toBeGreaterThanOrEqual(0);
      expect(proposal.planHealth.scheduledPercent).toBeLessThanOrEqual(100);
      expect(proposal.unschedulable.every((item) => item.suggestedActions.length > 0)).toBe(
        true,
      );
    },
  );
});
