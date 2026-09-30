import { describe, expect, it } from "vitest";
import {
  EXTRACTION_MODES,
  parsePersistedWorkspace,
} from "../lib/domain/workspace-state";

function workspace(extractionMode: (typeof EXTRACTION_MODES)[number]) {
  return {
    version: 1,
    tasks: [],
    proposal: {
      id: "proposal",
      sessions: [],
      breaks: [],
      unschedulable: [],
      planHealth: {
        scheduledPercent: 100,
        deadlinesAtRisk: 0,
        unscheduledMinutes: 0,
        bufferMinutesRetained: 0,
        demandingFocusBlocks: 0,
        fragmentedTaskIds: [],
        recurringGoalsOnTrack: 0,
        recurringGoalsBehind: 0,
        summary: "Nothing to schedule.",
      },
      availableMinutes: 0,
      plannedMinutes: 0,
      bufferMinutes: 0,
    },
    importText: "",
    history: [],
    sessionReviews: [],
    planningMode: "balanced",
    extractionMode,
  };
}

describe("persisted extraction modes", () => {
  it.each(EXTRACTION_MODES)("accepts %s workspaces", (mode) => {
    expect(parsePersistedWorkspace(workspace(mode)).extractionMode).toBe(mode);
  });

  it("rejects unknown extraction modes", () => {
    expect(() =>
      parsePersistedWorkspace({
        ...workspace("local"),
        extractionMode: "semantic-local-mashup",
      }),
    ).toThrow();
  });

  it("round-trips semantic task metadata through workspace validation", () => {
    const dateWindow = {
      start: "2026-09-03T12:00:00-07:00",
      end: "2026-09-03T17:00:00-07:00",
      label: "Thursday afternoon",
      precision: "named_period" as const,
    };
    const state = workspace("gemini-hybrid");
    const semanticFields = {
      responsibilityKind: "event" as const,
      deadlineStrength: "hard" as const,
      occurrenceWindow: dateWindow,
      durationRange: {
        minimumMinutes: 45,
        preferredMinutes: 60,
        maximumMinutes: 75,
      },
      schedulingConstraints: { allowedDateWindows: [dateWindow] },
      dependencies: [
        {
          taskId: "draft",
          targetTitle: "Draft",
          relation: "after" as const,
          strength: "hard" as const,
          minimumGapMinutes: 30,
          maximumLagMinutes: 1_440,
        },
      ],
      conditionalRules: [
        {
          condition: "Feedback is available",
          effect: "Review it during the meeting",
          requiresReview: false,
        },
      ],
    };
    const task = {
      title: "Feedback meeting",
      taskType: "fixed_time" as const,
      fixedStartAt: "2026-09-03T14:00:00-07:00",
      fixedEndAt: "2026-09-03T15:00:00-07:00",
      estimatedMinutes: 60,
      priority: "medium" as const,
      category: "school" as const,
      energyDemand: "medium" as const,
      splittable: false,
      confidence: 0.95,
      fieldConfidence: { title: 1, taskType: 1 },
      missingInformation: [],
      sourceText: "Meet Thursday at 2 PM for about an hour.",
      ...semanticFields,
    };

    const parsed = parsePersistedWorkspace({ ...state, tasks: [task] });

    expect(parsed.tasks[0]).toMatchObject(semanticFields);
  });
});
