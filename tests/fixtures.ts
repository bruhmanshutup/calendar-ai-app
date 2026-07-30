import type {
  ExtractedTask,
  SchedulingInput,
  SchedulingPreferences,
} from "../lib/domain/types";

export const TEST_PREFERENCES: SchedulingPreferences = {
  timeZone: "UTC",
  wakingTime: "07:00",
  sleepingTime: "23:00",
  preferredBlockMinutes: 45,
  maximumBlockMinutes: 90,
  preferredBreakMinutes: 10,
  planningMode: "balanced",
  weekendsAllowed: true,
  preferredFocusWindows: [{ start: "09:00", end: "12:00" }],
  preferredRoutineWindows: [{ start: "17:00", end: "20:00" }],
};

export function task(
  patch: Partial<ExtractedTask> & Pick<ExtractedTask, "id" | "title">,
): ExtractedTask {
  return {
    taskType: "flexible",
    estimatedMinutes: 45,
    priority: "medium",
    category: "work",
    energyDemand: "medium",
    splittable: false,
    minimumSessionMinutes: 15,
    confidence: 1,
    fieldConfidence: {
      title: 1,
      taskType: 1,
      estimatedMinutes: 1,
      priority: 1,
    },
    missingInformation: [],
    sourceText: patch.title,
    approved: true,
    reviewRequired: false,
    ...patch,
  };
}

export function scheduling(
  tasks: ExtractedTask[],
  patch: Partial<SchedulingInput> = {},
): SchedulingInput {
  return {
    windowStart: "2026-07-27T07:00:00.000Z",
    windowEnd: "2026-08-01T22:00:00.000Z",
    tasks,
    preferences: TEST_PREFERENCES,
    availability: [
      { start: "2026-07-27T08:00:00.000Z", end: "2026-07-27T18:00:00.000Z" },
      { start: "2026-07-28T08:00:00.000Z", end: "2026-07-28T18:00:00.000Z" },
      { start: "2026-07-29T08:00:00.000Z", end: "2026-07-29T18:00:00.000Z" },
      { start: "2026-07-30T08:00:00.000Z", end: "2026-07-30T18:00:00.000Z" },
      { start: "2026-07-31T08:00:00.000Z", end: "2026-07-31T18:00:00.000Z" },
    ],
    unavailableEvents: [],
    blockedTimes: [],
    lockedSessions: [],
    ...patch,
  };
}

