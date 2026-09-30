import { z } from "zod";

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Use a real calendar date.");
const localTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const confidence = z.number().min(0).max(1);
const weekday = z.enum([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);

const localWindow = z
  .object({
    date: localDate.optional(),
    startTime: localTime.optional(),
    endTime: localTime.optional(),
    period: z.string().trim().min(1).max(80).optional(),
    label: z.string().trim().min(1).max(180),
  })
  .superRefine((window, context) => {
    if (!window.date && !window.startTime && !window.endTime && !window.period) {
      context.addIssue({
        code: "custom",
        message: "A local window needs a date, clock boundary, or named period.",
      });
    }
  });

const boundary = z.object({
  date: localDate.optional(),
  time: localTime.optional(),
  period: z.string().trim().min(1).max(80).optional(),
  label: z.string().trim().min(1).max(180),
});

const factEvidence = z.object({
  sourceText: z.string().trim().min(1).max(4000),
  sourceStart: z.number().int().nonnegative(),
  sourceEnd: z.number().int().positive(),
});

export const semanticDraftSchema = z.object({
  responsibilities: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(120),
        title: z.string().trim().min(1).max(180),
        kind: z.enum(["task", "event", "reminder", "milestone"]),
        sourceText: z.string().trim().min(1).max(4000),
        sourceStart: z.number().int().nonnegative().optional(),
        sourceEnd: z.number().int().positive().optional(),
        factEvidence: z.array(factEvidence).max(30).optional(),
        deadline: z
          .object({
            date: localDate,
            time: localTime.optional(),
            period: z.string().trim().min(1).max(80).optional(),
            strength: z.enum(["hard", "soft"]),
            confidence,
          })
          .optional(),
        occurrence: z
          .object({
            date: localDate,
            dateSourceText: z.string().trim().max(4000).optional(),
            startTime: localTime.optional(),
            endTime: localTime.optional(),
            period: z.string().trim().min(1).max(80).optional(),
            confidence,
          })
          .optional(),
        duration: z
          .object({
            minimumMinutes: z.number().int().positive().max(1440).optional(),
            preferredMinutes: z.number().int().positive().max(1440).optional(),
            maximumMinutes: z.number().int().positive().max(1440).optional(),
            explicit: z.boolean(),
            approximate: z.boolean().optional(),
          })
          .optional(),
        constraints: z
          .object({
            earliestStart: boundary.optional(),
            latestEnd: boundary.optional(),
            allowedWindows: z.array(localWindow).max(14).optional(),
            preferredWindows: z.array(localWindow).max(14).optional(),
          })
          .optional(),
        recurrence: z
          .object({
            frequency: z.enum(["daily", "weekly", "monthly"]),
            interval: z.number().int().positive().max(365).optional(),
            count: z.number().int().positive().max(31).optional(),
            daysOfWeek: z.array(weekday).max(7).optional(),
            startDate: localDate.optional(),
            endDate: localDate.optional(),
            endCondition: z.string().trim().min(1).max(240).optional(),
            exactTimes: z
              .array(
                z.object({
                  daysOfWeek: z.array(weekday).min(1).max(7),
                  time: localTime,
                }),
              )
              .max(28)
              .optional(),
          })
          .optional(),
        conditionalRules: z
          .array(
            z.object({
              condition: z.string().trim().min(1).max(300),
              effect: z.string().trim().min(1).max(300),
              requiresReview: z.boolean().optional(),
            }),
          )
          .max(12)
          .optional(),
        planning: z
          .object({
            estimatedMinutes: z.number().int().positive().max(1440).optional(),
            priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
            category: z
              .enum([
                "school",
                "work",
                "health",
                "fitness",
                "errand",
                "personal",
                "other",
              ])
              .optional(),
            energyDemand: z.enum(["low", "medium", "high"]).optional(),
            splittable: z.boolean().optional(),
            minimumSessionMinutes: z
              .number()
              .int()
              .positive()
              .max(240)
              .optional(),
            maximumSessionMinutes: z
              .number()
              .int()
              .positive()
              .max(1440)
              .optional(),
            sessionCount: z.number().int().min(2).max(31).optional(),
          })
          .optional(),
        confidence,
        missingInformation: z.array(z.string().trim().min(1)).max(20),
        reviewRequired: z.boolean(),
      }),
    )
    .max(100),
  relations: z
    .array(
      z.object({
        fromId: z.string().trim().min(1).max(120),
        toId: z.string().trim().min(1).max(120),
        relation: z.enum(["before", "after"]),
        strength: z.enum(["hard", "soft"]),
        minimumGapMinutes: z.number().int().nonnegative().max(60 * 24 * 60).optional(),
        maximumLagMinutes: z.number().int().nonnegative().max(60 * 24 * 60).optional(),
        sourceText: z.string().trim().min(1).max(4000).optional(),
        fromText: z.string().trim().min(1).max(180).optional(),
        toText: z.string().trim().min(1).max(180).optional(),
        timing: z.enum(["ordering", "offset", "arrival_buffer", "travel"]).optional(),
        fromBoundary: z.enum(["start", "end"]).optional(),
        toBoundary: z.enum(["start", "end"]).optional(),
        mode: z.enum(["exact", "latest", "earliest"]).optional(),
        approximate: z.boolean().optional(),
        reason: z.string().trim().min(1).max(300),
      }),
    )
    .max(100),
  blockedTimes: z
    .array(
      z.object({
        date: localDate,
        startTime: localTime,
        endTime: localTime,
        label: z.string().trim().min(1).max(180),
      }),
    )
    .max(100),
  globalInstructions: z
    .array(
      z.object({
        sourceText: z.string().trim().min(1).max(4000),
        sourceStart: z.number().int().nonnegative().optional(),
        sourceEnd: z.number().int().positive().optional(),
      }),
    )
    .max(100),
  ignoredStatements: z
    .array(
      z.object({
        sourceText: z.string().trim().min(1).max(4000),
        reason: z.string().trim().min(1).max(500),
      }),
    )
    .max(100),
});

export type SemanticDraft = z.infer<typeof semanticDraftSchema>;

// Kept deliberately smaller and shallower than the persisted task schema so
// Gemini can enforce it natively. Local calendar values are compiled into
// offset-aware instants after the response is received.
export const GEMINI_SEMANTIC_DRAFT_SCHEMA = {
  type: "object",
  properties: {
    responsibilities: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          kind: {
            type: "string",
            enum: ["task", "event", "milestone"],
          },
          sourceText: { type: "string" },
          sourceStart: { type: "integer" },
          sourceEnd: { type: "integer" },
          factEvidence: {
            type: "array",
            items: {
              type: "object",
              properties: {
                sourceText: { type: "string" },
                sourceStart: { type: "integer" },
                sourceEnd: { type: "integer" },
              },
              required: ["sourceText", "sourceStart", "sourceEnd"],
            },
          },
          deadline: {
            type: "object",
            properties: {
              date: { type: "string" },
              time: { type: "string" },
              period: { type: "string" },
              strength: { type: "string", enum: ["hard", "soft"] },
              confidence: { type: "number" },
            },
            required: ["date", "strength", "confidence"],
          },
          occurrence: {
            type: "object",
            properties: {
              date: { type: "string" },
              dateSourceText: { type: "string", description: "Exact source words establishing the date, or an empty string if no date is stated. Never quote the reference date from the instructions." },
              startTime: { type: "string" },
              endTime: { type: "string" },
              period: { type: "string" },
              confidence: { type: "number" },
            },
            required: ["date", "dateSourceText", "confidence"],
          },
          duration: {
            type: "object",
            properties: {
              minimumMinutes: { type: "integer" },
              preferredMinutes: { type: "integer" },
              maximumMinutes: { type: "integer" },
              explicit: { type: "boolean" },
              approximate: { type: "boolean" },
            },
            required: ["explicit"],
          },
          constraints: {
            type: "object",
            properties: {
              earliestStart: {
                type: "object",
                properties: {
                  date: { type: "string" },
                  time: { type: "string" },
                  period: { type: "string" },
                  label: { type: "string" },
                },
                required: ["label"],
              },
              latestEnd: {
                type: "object",
                properties: {
                  date: { type: "string" },
                  time: { type: "string" },
                  period: { type: "string" },
                  label: { type: "string" },
                },
                required: ["label"],
              },
              allowedWindows: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    date: { type: "string" },
                    startTime: { type: "string" },
                    endTime: { type: "string" },
                    period: { type: "string" },
                    label: { type: "string" },
                  },
                  required: ["label"],
                },
              },
              preferredWindows: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    date: { type: "string" },
                    startTime: { type: "string" },
                    endTime: { type: "string" },
                    period: { type: "string" },
                    label: { type: "string" },
                  },
                  required: ["label"],
                },
              },
            },
          },
          recurrence: {
            type: "object",
            properties: {
              frequency: {
                type: "string",
                enum: ["daily", "weekly", "monthly"],
              },
              interval: { type: "integer" },
              count: { type: "integer" },
              daysOfWeek: {
                type: "array",
                items: {
                  type: "string",
                  enum: [
                    "monday",
                    "tuesday",
                    "wednesday",
                    "thursday",
                    "friday",
                    "saturday",
                    "sunday",
                  ],
                },
              },
              startDate: { type: "string" },
              endDate: { type: "string" },
              endCondition: { type: "string" },
              exactTimes: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    daysOfWeek: {
                      type: "array",
                      items: {
                        type: "string",
                        enum: [
                          "monday",
                          "tuesday",
                          "wednesday",
                          "thursday",
                          "friday",
                          "saturday",
                          "sunday",
                        ],
                      },
                    },
                    time: { type: "string" },
                  },
                  required: ["daysOfWeek", "time"],
                },
              },
            },
            required: ["frequency"],
          },
          conditionalRules: {
            type: "array",
            items: {
              type: "object",
              properties: {
                condition: { type: "string" },
                effect: { type: "string" },
                requiresReview: { type: "boolean" },
              },
              required: ["condition", "effect"],
            },
          },
          planning: {
            type: "object",
            properties: {
              estimatedMinutes: { type: "integer", minimum: 1, maximum: 1440 },
              priority: {
                type: "string",
                enum: ["low", "medium", "high", "urgent"],
              },
              category: {
                type: "string",
                enum: [
                  "school",
                  "work",
                  "health",
                  "fitness",
                  "errand",
                  "personal",
                  "other",
                ],
              },
              energyDemand: {
                type: "string",
                enum: ["low", "medium", "high"],
              },
              splittable: { type: "boolean" },
              minimumSessionMinutes: { type: "integer" },
              maximumSessionMinutes: {
                type: "integer",
                minimum: 1,
                maximum: 1440,
              },
              sessionCount: { type: "integer", minimum: 2, maximum: 31 },
            },
          },
          confidence: { type: "number" },
          missingInformation: {
            type: "array",
            items: { type: "string" },
          },
          reviewRequired: { type: "boolean" },
        },
        required: [
          "id",
          "title",
          "kind",
          "sourceText",
          "factEvidence",
          "confidence",
          "missingInformation",
          "reviewRequired",
        ],
      },
    },
    relations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          fromId: { type: "string" },
          toId: { type: "string" },
          relation: { type: "string", enum: ["before", "after"] },
          strength: { type: "string", enum: ["hard", "soft"] },
          minimumGapMinutes: { type: "integer" },
          maximumLagMinutes: { type: "integer" },
          sourceText: { type: "string" },
          fromText: { type: "string" },
          toText: { type: "string" },
          timing: { type: "string", enum: ["ordering", "offset", "arrival_buffer", "travel"] },
          fromBoundary: { type: "string", enum: ["start", "end"] },
          toBoundary: { type: "string", enum: ["start", "end"] },
          mode: { type: "string", enum: ["exact", "latest", "earliest"] },
          approximate: { type: "boolean" },
          reason: { type: "string" },
        },
        required: ["fromId", "toId", "relation", "strength", "reason"],
      },
    },
    blockedTimes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          date: { type: "string" },
          startTime: { type: "string" },
          endTime: { type: "string" },
          label: { type: "string" },
        },
        required: ["date", "startTime", "endTime", "label"],
      },
    },
    globalInstructions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sourceText: { type: "string" },
          sourceStart: { type: "integer" },
          sourceEnd: { type: "integer" },
        },
        required: ["sourceText"],
      },
    },
    ignoredStatements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sourceText: { type: "string" },
          reason: { type: "string" },
        },
        required: ["sourceText", "reason"],
      },
    },
  },
  required: [
    "responsibilities",
    "relations",
    "blockedTimes",
    "globalInstructions",
    "ignoredStatements",
  ],
} as const;
