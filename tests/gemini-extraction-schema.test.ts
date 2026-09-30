import { describe, expect, it } from "vitest";
import { extractionResultSchema } from "../lib/domain/extraction-schema";
import { GEMINI_EXTRACTION_SCHEMA } from "../lib/providers/gemini-extraction-schema";

describe("Gemini extraction schema contract", () => {
  const taskProperties = GEMINI_EXTRACTION_SCHEMA.properties.tasks.items.properties;

  it("exposes current temporal, semantic, dependency, and source evidence fields", () => {
    expect(taskProperties.responsibilityKind).toMatchObject({
      type: "string",
      enum: ["task", "event", "reminder", "milestone"],
    });
    expect(taskProperties.deadlineStrength).toMatchObject({
      type: "string",
      enum: ["hard", "soft"],
    });
    expect(taskProperties.dueWindow.required).toEqual([
      "start",
      "end",
      "label",
      "precision",
    ]);
    expect(taskProperties.occurrenceWindow).toBe(taskProperties.dueWindow);
    expect(taskProperties.durationRange).toMatchObject({
      type: "object",
      required: ["minimumMinutes"],
      properties: {
        minimumMinutes: { type: "integer", minimum: 1, maximum: 1440 },
        maximumMinutes: { type: "integer", minimum: 1, maximum: 1440 },
        preferredMinutes: { type: "integer", minimum: 1, maximum: 1440 },
      },
    });
    expect(
      taskProperties.schedulingConstraints.properties.allowedDateWindows,
    ).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 14,
      items: taskProperties.dueWindow,
    });
    expect(
      taskProperties.schedulingConstraints.properties.preferredDateWindows,
    ).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 14,
      items: taskProperties.dueWindow,
    });
    expect(taskProperties.sequence).toMatchObject({
      type: "object",
      required: ["groupId", "order"],
      properties: {
        order: { type: "integer", minimum: 0, maximum: 1_000_000 },
        minimumGapDays: { type: "integer", minimum: 0, maximum: 31 },
      },
    });
    expect(taskProperties.dependencies).toMatchObject({
      type: "array",
      maxItems: 20,
      items: {
        required: ["relation"],
        properties: {
          relation: { type: "string", enum: ["before", "after"] },
          targetTitle: { type: "string", minLength: 1, maxLength: 180 },
          strength: { type: "string", enum: ["hard", "soft"] },
          minimumGapMinutes: { type: "integer", minimum: 0, maximum: 525_600 },
          maximumLagMinutes: { type: "integer", minimum: 0, maximum: 525_600 },
        },
      },
    });
    expect(taskProperties.conditionalRules).toMatchObject({
      type: "array",
      maxItems: 20,
      items: {
        required: ["condition", "effect"],
        properties: {
          requiresReview: { type: "boolean" },
        },
      },
    });
    expect(taskProperties.sourceSpan).toMatchObject({
      type: "object",
      required: ["start", "end", "quote"],
      properties: {
        start: { type: "integer", minimum: 0 },
        end: { type: "integer", minimum: 1 },
      },
    });
    expect(taskProperties.dependencies.items.properties.evidence).toBe(
      taskProperties.sourceSpan,
    );
  });

  it("describes semantic fields accepted by the domain extraction contract", () => {
    const sourceText =
      "Send the thermal sketch Wednesday afternoon, then revise it Thursday evening.";
    const sourceSpan = {
      sourceId: "email-import",
      start: 0,
      end: sourceText.length,
      quote: sourceText,
    };
    const afternoon = {
      start: "2026-09-02T12:00:00-07:00",
      end: "2026-09-02T17:00:00-07:00",
      label: "Wednesday afternoon",
      precision: "named_period" as const,
    };

    const parsed = extractionResultSchema.parse({
      tasks: [
        {
          id: "send-sketch",
          title: "Send the thermal sketch",
          taskType: "flexible",
          responsibilityKind: "milestone",
          deadlineStrength: "hard",
          dueDate: "2026-09-02",
          dueWindow: afternoon,
          occurrenceWindow: afternoon,
          estimatedMinutes: 40,
          durationRange: {
            minimumMinutes: 30,
            maximumMinutes: 60,
            preferredMinutes: 40,
          },
          effortEstimateSource: "ai",
          effortEstimateRationale: "The source gives no exact effort duration.",
          priority: "medium",
          category: "work",
          energyDemand: "medium",
          splittable: false,
          minimumSessionMinutes: 40,
          schedulingConstraints: {
            allowedDateWindows: [afternoon],
            preferredDateWindows: [afternoon],
          },
          sequence: {
            groupId: "thermal-sketch-workflow",
            order: 0,
            week: 1,
            day: 3,
            anchorDate: "2026-08-31",
            minimumGapDays: 0,
          },
          dependencies: [
            {
              taskId: "revise-sketch",
              targetTitle: "Revise the thermal sketch",
              relation: "before",
              strength: "hard",
              minimumGapMinutes: 30,
              maximumLagMinutes: 1_440,
              evidence: sourceSpan,
            },
          ],
          conditionalRules: [
            {
              condition: "If the reviewer requests changes",
              effect: "Revise the sketch before submission",
              requiresReview: true,
            },
          ],
          confidence: 0.94,
          fieldConfidence: { title: 0.99, taskType: 0.91 },
          missingInformation: [],
          sourceText,
          sourceSpan,
        },
      ],
      ignoredStatements: [],
    });

    expect(parsed.tasks[0]).toMatchObject({
      responsibilityKind: "milestone",
      deadlineStrength: "hard",
      dueWindow: afternoon,
      occurrenceWindow: afternoon,
      durationRange: {
        minimumMinutes: 30,
        maximumMinutes: 60,
        preferredMinutes: 40,
      },
      schedulingConstraints: {
        allowedDateWindows: [afternoon],
        preferredDateWindows: [afternoon],
      },
      sequence: { groupId: "thermal-sketch-workflow", order: 0 },
      dependencies: [
        {
          taskId: "revise-sketch",
          targetTitle: "Revise the thermal sketch",
          relation: "before",
          strength: "hard",
          minimumGapMinutes: 30,
          maximumLagMinutes: 1_440,
        },
      ],
      conditionalRules: [
        {
          condition: "If the reviewer requests changes",
          effect: "Revise the sketch before submission",
          requiresReview: true,
        },
      ],
      sourceSpan,
    });
  });
});
