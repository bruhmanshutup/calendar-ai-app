import { describe, expect, it } from "vitest";
import { extractedTaskSchema } from "../lib/domain/extraction-schema";
import type { ExtractedTask } from "../lib/domain/types";

const legacyTask: ExtractedTask = {
  id: "legacy-task",
  title: "Submit the legacy report",
  taskType: "flexible",
  estimatedMinutes: 45,
  priority: "medium",
  category: "work",
  energyDemand: "medium",
  splittable: false,
  confidence: 0.9,
  fieldConfidence: { title: 1, taskType: 1 },
  missingInformation: [],
  sourceText: "Submit the legacy report.",
};

const afternoon = {
  start: "2026-09-03T12:00:00-07:00",
  end: "2026-09-03T17:00:00-07:00",
  label: "Thursday afternoon",
  precision: "named_period" as const,
};

describe("semantic extraction metadata", () => {
  it("keeps legacy task payloads valid when all new metadata is absent", () => {
    expect(extractedTaskSchema.safeParse(legacyTask).success).toBe(true);
  });

  it("accepts the optional semantic metadata without changing legacy fields", () => {
    const candidate: ExtractedTask = {
      ...legacyTask,
      responsibilityKind: "reminder",
      deadlineStrength: "soft",
      durationRange: {
        minimumMinutes: 20,
        maximumMinutes: 45,
        preferredMinutes: 30,
      },
      occurrenceWindow: afternoon,
      schedulingConstraints: {
        allowedDateWindows: [afternoon],
      },
      dependencies: [
        {
          targetTitle: "Receive reviewer feedback",
          relation: "after",
          strength: "soft",
          minimumGapMinutes: 30,
          maximumLagMinutes: 1_440,
        },
      ],
      conditionalRules: [
        {
          condition: "An exam is scheduled the next day",
          effect: "Extend the review to 90 minutes",
          requiresReview: true,
        },
      ],
    };

    expect(extractedTaskSchema.parse(candidate)).toMatchObject(candidate);
  });

  it.each([
    {
      label: "maximum below minimum",
      durationRange: { minimumMinutes: 60, maximumMinutes: 30 },
    },
    {
      label: "preferred below minimum",
      durationRange: { minimumMinutes: 60, preferredMinutes: 45 },
    },
    {
      label: "preferred above maximum",
      durationRange: {
        minimumMinutes: 30,
        maximumMinutes: 60,
        preferredMinutes: 90,
      },
    },
  ])("rejects a duration range with $label", ({ durationRange }) => {
    expect(
      extractedTaskSchema.safeParse({ ...legacyTask, durationRange }).success,
    ).toBe(false);
  });
});
