import { z } from "zod";

const dayOfWeekSchema = z.enum([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);

const confidenceSchema = z.number().min(0).max(1);
const clockTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const sourceEvidenceSpanSchema = z
  .object({
    sourceId: z.string().trim().min(1).max(180).optional(),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    quote: z.string().min(1).max(4000),
  })
  .refine((span) => span.end > span.start, {
    message: "A source span must end after it starts.",
  });
const clockWindowSchema = z
  .object({ start: clockTimeSchema, end: clockTimeSchema })
  .refine((window) => window.start !== window.end, {
    message: "A time window must have different start and end times.",
  });
const temporalWindowSchema = z
  .object({
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
    label: z.string().trim().min(1).max(180),
    precision: z.enum(["exact", "named_period", "approximate"]),
  })
  .refine((window) => new Date(window.end) > new Date(window.start), {
    message: "A temporal window must end after it starts.",
    path: ["end"],
  });
const taskClassificationSchema = z.object({
  kind: z.enum(["task", "event", "reminder", "milestone"]),
  timing: z.enum(["fixed_time", "deadline", "flexible_window", "all_day", "unresolved"]),
  recurrence: z.enum(["once", "recurring"]),
});
const durationRangeSchema = z
  .object({
    minimumMinutes: z.number().int().positive().max(24 * 60),
    maximumMinutes: z.number().int().positive().max(24 * 60).optional(),
    preferredMinutes: z.number().int().positive().max(24 * 60).optional(),
  })
  .superRefine((range, context) => {
    if (
      range.maximumMinutes !== undefined &&
      range.maximumMinutes < range.minimumMinutes
    ) {
      context.addIssue({
        code: "custom",
        path: ["maximumMinutes"],
        message: "Maximum duration must not be less than minimum duration.",
      });
    }
    if (
      range.preferredMinutes !== undefined &&
      range.preferredMinutes < range.minimumMinutes
    ) {
      context.addIssue({
        code: "custom",
        path: ["preferredMinutes"],
        message: "Preferred duration must not be less than minimum duration.",
      });
    }
    if (
      range.maximumMinutes !== undefined &&
      range.preferredMinutes !== undefined &&
      range.preferredMinutes > range.maximumMinutes
    ) {
      context.addIssue({
        code: "custom",
        path: ["preferredMinutes"],
        message: "Preferred duration must not exceed maximum duration.",
      });
    }
  });

export const planningRulesSchema = z.object({
  earliestWorkTime: clockTimeSchema.optional(),
  latestWorkTime: clockTimeSchema.optional(),
  blockedTimes: z
    .array(
      z
        .object({
          start: z.string().datetime({ offset: true }),
          end: z.string().datetime({ offset: true }),
          label: z.string().trim().min(1).max(180),
        })
        .refine((interval) => new Date(interval.end) > new Date(interval.start), {
          message: "A blocked interval must end after it starts.",
        }),
    )
    .max(100)
    .optional(),
});

export const extractedTaskSchema = z
  .object({
    id: z.string().optional(),
    title: z.string().trim().min(1).max(180).describe("One direct, user-owned responsibility or event. Do not use a global rule, quoted history, background fact, or another person's task as a title."),
    description: z.string().trim().max(2000).optional(),
    taskType: z.enum(["flexible", "fixed_time", "recurring_goal"]).describe("Flexible work, a fixed occurrence, or one recurring responsibility. A deadline is flexible work; an occurrence at a clock is fixed_time."),
    responsibilityKind: z
      .enum(["task", "event", "reminder", "milestone"])
      .optional(),
    classification: taskClassificationSchema.optional().describe("App-derived classification; providers may omit it."),
    deadlineStrength: z.enum(["hard", "soft"]).optional(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Latest completion date, not the date of a meeting or class occurrence. Resolve relative dates from the supplied local date."),
    dueTime: z.string().regex(/^\d{2}:\d{2}$/).optional().describe("Latest completion clock HH:mm. Do not copy a preferred time or an availability boundary here."),
    dueAt: z.string().datetime({ offset: true }).optional(),
    dueWindow: temporalWindowSchema.optional(),
    occurrenceWindow: temporalWindowSchema.optional(),
    fixedStartAt: z.string().datetime({ offset: true }).optional().describe("Exact local start of a scheduled occurrence. Null for flexible work and recurring items."),
    fixedEndAt: z.string().datetime({ offset: true }).optional().describe("Explicit or arithmetically derived end of a scheduled occurrence. Do not invent an end when no duration supports it."),
    estimatedMinutes: z.number().int().positive().max(24 * 60).optional().describe("Total active effort for one responsibility, or effort for one recurring occurrence. Preserve a stated duration exactly; do not replace a range with a midpoint."),
    durationRange: durationRangeSchema.optional().describe("Explicit duration range or lower bound only. Preserve minimum and maximum; leave maximum absent for an unbounded lower bound."),
    effortEstimateSource: z.enum(["stated", "ai", "heuristic"]).optional(),
    effortEstimateRationale: z.string().trim().min(1).max(300).optional(),
    priority: z.enum(["low", "medium", "high", "urgent"]),
    category: z.enum([
      "school",
      "work",
      "health",
      "fitness",
      "errand",
      "personal",
      "other",
    ]),
    energyDemand: z.enum(["low", "medium", "high"]),
    splittable: z.boolean(),
    minimumSessionMinutes: z.number().int().positive().max(240).optional(),
    schedulingConstraints: z
      .object({
        calculatedTiming: z.object({
          approximate: z.boolean(),
          durationEstimated: z.boolean(),
          buffer: z.object({ start: z.string(), end: z.string() }).optional(),
        }).optional(),
        linkedTiming: z.object({
          rules: z.array(z.object({
            taskId: z.string().trim().min(1).max(180),
            boundary: z.enum(["start", "end"]),
            targetBoundary: z.enum(["start", "end"]),
            offsetMinutes: z.number().int().min(-86_400).max(86_400),
            mode: z.enum(["exact", "latest", "earliest"]),
            approximate: z.boolean(),
          })).min(1).max(32),
          approximate: z.boolean(),
          durationEstimated: z.boolean(),
          arrivalBuffer: z.boolean(),
          unresolved: z.boolean().optional(),
        }).optional(),
        allowedTimeWindows: z.array(clockWindowSchema).min(1).max(14).optional(),
        allowedDateWindows: z
          .array(temporalWindowSchema)
          .min(1)
          .max(14)
          .optional(),
        preferredTimeWindows: z.array(clockWindowSchema).min(1).max(14).optional(),
        preferredDateWindows: z
          .array(temporalWindowSchema)
          .min(1)
          .max(14)
          .optional(),
        avoidConsecutiveDays: z.boolean().optional(),
        sessionCount: z.number().int().min(2).max(31).optional(),
        minimumDistinctDays: z.number().int().min(2).max(31).optional(),
        maximumSessionMinutes: z
          .number()
          .int()
          .positive()
          .max(24 * 60)
          .optional(),
      })
      .describe("Hard and soft time, date, session, buffer, and linked-timing restrictions. Keep partial-day restrictions here rather than broadening them into whole-day exclusions.")
      .optional(),
    sequence: z
      .object({
        groupId: z.string().trim().min(1).max(120),
        order: z.number().int().nonnegative().max(1_000_000),
        week: z.number().int().positive().max(1_000).optional(),
        day: z.number().int().positive().max(366).optional(),
        anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        minimumGapDays: z.number().int().min(0).max(31).optional(),
      })
      .optional(),
    recurrence: z
      .object({
        frequency: z.enum(["daily", "weekly", "monthly"]),
        mode: z.enum(["quota", "fixed_times"]).optional(),
        interval: z.number().int().positive().max(365).optional(),
        anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        occurrenceLimit: z.number().int().positive().max(10_000).optional(),
        count: z.number().int().positive().max(31).optional(),
        daysOfWeek: z.array(dayOfWeekSchema).max(7).optional(),
        timeRules: z
          .array(
            z.object({
              daysOfWeek: z.array(dayOfWeekSchema).min(1).max(7),
              time: clockTimeSchema,
            }),
          )
          .min(1)
          .max(28)
          .optional(),
        monthlyRules: z
          .array(
            z.discriminatedUnion("type", [
              z.object({
                type: z.literal("days_of_month"),
                daysOfMonth: z.array(z.number().int().min(1).max(31)).min(1).max(31),
                times: z.array(clockTimeSchema).min(1).max(8),
              }),
              z.object({
                type: z.literal("ordinal_weekday"),
                ordinal: z.union([
                  z.literal(1),
                  z.literal(2),
                  z.literal(3),
                  z.literal(4),
                  z.literal(5),
                  z.literal(-1),
                ]),
                dayOfWeek: dayOfWeekSchema,
                times: z.array(clockTimeSchema).min(1).max(8),
              }),
              z.object({
                type: z.literal("last_day_of_month"),
                times: z.array(clockTimeSchema).min(1).max(8),
              }),
            ]),
          )
          .min(1)
          .max(12)
          .optional(),
        dateOverrides: z
          .array(
            z
              .object({
                date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
                skip: z.boolean().optional(),
                times: z.array(clockTimeSchema).min(1).max(8).optional(),
              })
              .superRefine((override, context) => {
                if (!override.skip && !override.times?.length) {
                  context.addIssue({
                    code: "custom",
                    path: ["times"],
                    message: "A date override must either skip the date or provide times.",
                  });
                }
                if (override.skip && override.times?.length) {
                  context.addIssue({
                    code: "custom",
                    path: ["times"],
                    message: "A skipped date cannot also provide occurrence times.",
                  });
                }
              }),
          )
          .max(50)
          .optional(),
        windowStart: z.string().datetime({ offset: true }).optional(),
        windowEnd: z.string().datetime({ offset: true }).optional(),
      })
      .superRefine((recurrence, context) => {
        if (
          recurrence.mode !== "fixed_times" &&
          (recurrence.timeRules?.length || recurrence.monthlyRules?.length)
        ) {
          context.addIssue({
            code: "custom",
            path: ["mode"],
            message: "Recurring time rules require fixed_times mode.",
          });
        }
        const assignedDayTimes = new Set<string>();
        recurrence.timeRules?.forEach((rule, ruleIndex) => {
          rule.daysOfWeek.forEach((day, dayIndex) => {
            const key = `${day}|${rule.time}`;
            if (assignedDayTimes.has(key)) {
              context.addIssue({
                code: "custom",
                path: ["timeRules", ruleIndex, "daysOfWeek", dayIndex],
                message: `${day} repeats the ${rule.time} recurring time.`,
              });
            }
            assignedDayTimes.add(key);
          });
        });
        if (recurrence.frequency === "monthly" && recurrence.timeRules?.length) {
          context.addIssue({
            code: "custom",
            path: ["timeRules"],
            message: "Monthly recurrences must use monthlyRules.",
          });
        }
        if (recurrence.frequency !== "monthly" && recurrence.monthlyRules?.length) {
          context.addIssue({
            code: "custom",
            path: ["monthlyRules"],
            message: "monthlyRules require monthly frequency.",
          });
        }
        if (
          recurrence.windowStart &&
          recurrence.windowEnd &&
          new Date(recurrence.windowEnd) < new Date(recurrence.windowStart)
        ) {
          context.addIssue({
            code: "custom",
            path: ["windowEnd"],
            message: "The recurrence end must not precede its start.",
          });
        }
      })
      .describe("One recurring responsibility with cadence, exact clock rules, and date-specific replacements or skips. Keep per-occurrence effort in estimatedMinutes.")
      .optional(),
    confidence: confidenceSchema,
    fieldConfidence: z.object({
      title: confidenceSchema,
      taskType: confidenceSchema,
      dueDate: confidenceSchema.optional(),
      dueTime: confidenceSchema.optional(),
      estimatedMinutes: confidenceSchema.optional(),
      priority: confidenceSchema.optional(),
      recurrence: confidenceSchema.optional(),
    }),
    missingInformation: z.array(z.string().trim().min(1)).max(20).describe("Unresolved facts that can change identity, time, deadline, recurrence, dependency, or feasibility. Preserve ambiguity instead of guessing."),
    sourceText: z.string().trim().min(1).max(4000).describe("Complete contiguous source span for this responsibility, including qualifying duration, deadline, dependency, preference, recurrence, and restriction sentences."),
    sourceSpan: sourceEvidenceSpanSchema.optional(),
    sourceDocument: z.object({
      id: z.string().uuid(),
      name: z.string().min(1).max(255),
      pages: z.array(z.number().int().min(1).max(1000)).max(10),
    }).optional(),
    fieldProvenance: z
      .array(
        z.object({
          path: z.string().trim().min(1).max(120),
          origin: z.enum(["explicit", "derived", "inferred", "user"]),
          evidence: z.array(sourceEvidenceSpanSchema).max(8).optional(),
          rationale: z.string().trim().min(1).max(500).optional(),
        }),
      )
      .max(40)
      .optional(),
    dependencies: z
      .array(
        z.object({
          taskId: z.string().trim().min(1).max(180).optional(),
          targetTitle: z.string().trim().min(1).max(180).optional(),
          relation: z.enum(["before", "after"]),
          strength: z.enum(["hard", "soft"]).optional(),
          minimumGapMinutes: z
            .number()
            .int()
            .nonnegative()
            .max(365 * 24 * 60)
            .optional(),
          maximumLagMinutes: z
            .number()
            .int()
            .nonnegative()
            .max(365 * 24 * 60)
            .optional(),
          evidence: sourceEvidenceSpanSchema.optional(),
        }),
      )
      .max(20)
      .describe("Explicit prerequisite or ordering links. Use targetTitle or taskId, preserve direction, and put only stated separation in minimumGapMinutes.")
      .optional(),
    conditionalRules: z
      .array(
        z.object({
          condition: z.string().trim().min(1).max(500),
          effect: z.string().trim().min(1).max(500),
          requiresReview: z.boolean().optional(),
        }),
      )
      .max(20)
      .describe("Conditional activation and effects that must not be silently turned into unconditional work.")
      .optional(),
    approved: z.boolean().optional(),
    reviewRequired: z.boolean().optional(),
    completed: z.boolean().optional(),
    completedAt: z.string().datetime({ offset: true }).optional(),
    completedMinutes: z.number().int().min(0).optional(),
    cancelled: z.boolean().optional(),
    cancelledAt: z.string().datetime({ offset: true }).optional(),
  })
  .superRefine((task, context) => {
    if (
      task.recurrence?.mode === "fixed_times" &&
      !task.recurrence.timeRules?.length &&
      !task.recurrence.monthlyRules?.length &&
      !task.reviewRequired
    ) {
      context.addIssue({
        code: "custom",
        path: ["recurrence"],
        message: "A fixed recurring schedule without exact rules must require review.",
      });
    }
    if (
      (task.recurrence?.interval ?? 1) > 1 &&
      task.recurrence?.mode === "fixed_times" &&
      !task.recurrence?.anchorDate &&
      !task.reviewRequired
    ) {
      context.addIssue({
        code: "custom",
        path: ["recurrence", "anchorDate"],
        message: "A fixed-time interval recurrence needs an anchor date or review.",
      });
    }
    // Keep a known clock while an incomplete date awaits user confirmation.
    // Review-required tasks are excluded from automatic scheduling.
    if (task.dueTime && !task.dueDate && !(task.reviewRequired && !task.dueAt && task.missingInformation.length > 0)) {
      context.addIssue({
        code: "custom",
        path: ["dueTime"],
        message: "A due time requires a due date or an unresolved date marked for review with missing information and no dueAt.",
      });
    }
    if (task.fixedStartAt && task.fixedEndAt) {
      if (new Date(task.fixedEndAt) <= new Date(task.fixedStartAt)) {
        context.addIssue({
          code: "custom",
          path: ["fixedEndAt"],
          message: "Fixed end must occur after fixed start.",
        });
      }
    }
    if (
      task.estimatedMinutes &&
      task.minimumSessionMinutes &&
      task.minimumSessionMinutes > task.estimatedMinutes
    ) {
      context.addIssue({
        code: "custom",
        path: ["minimumSessionMinutes"],
        message: "Minimum session length cannot exceed total estimated effort.",
      });
    }
  });

export const extractionResultSchema = z.object({
  tasks: z.array(extractedTaskSchema).max(100),
  ignoredStatements: z
    .array(
      z.object({
        sourceText: z.string().trim().min(1).max(4000),
        reason: z.string().trim().min(1).max(500),
      }),
    )
    .max(100),
  planningRules: planningRulesSchema.optional(),
  interpretation: z
    .object({
      discoveredResponsibilityCount: z.number().int().nonnegative(),
      explicitFieldCount: z.number().int().nonnegative(),
      derivedFieldCount: z.number().int().nonnegative(),
      inferredFieldCount: z.number().int().nonnegative(),
      globalInstructions: z.array(sourceEvidenceSpanSchema).max(100),
      validationWarnings: z.array(z.string().trim().min(1).max(500)).max(100),
    })
    .optional(),
});

export type ValidatedExtractionResult = z.infer<
  typeof extractionResultSchema
>;

export function validateAndDedupeExtraction(
  value: unknown,
): ValidatedExtractionResult {
  const validated = extractionResultSchema.parse(value);
  const seen = new Set<string>();
  // An explicit fixed-times recurrence describes a series, even if a provider
  // also labels its first occurrence as fixed_time. Canonicalize that storage
  // representation so the scheduler expands the series instead of just one event.
  const normalizedTasks = validated.tasks.map((task) => {
    if (task.taskType !== "fixed_time" || task.recurrence?.mode !== "fixed_times") return task;
    return {
      ...task,
      taskType: "recurring_goal" as const,
      recurrence: { ...task.recurrence, windowStart: task.recurrence.windowStart ?? task.fixedStartAt },
      fixedStartAt: undefined,
      fixedEndAt: undefined,
    };
  });
  const tasks = normalizedTasks.filter((task) => {
    const key = [
      task.title.trim().toLocaleLowerCase(),
      task.taskType,
      task.dueAt ?? "",
      task.dueWindow?.start ?? "",
      task.dueWindow?.end ?? "",
      task.dueDate ?? "",
      task.fixedStartAt ?? "",
      JSON.stringify(task.recurrence ?? null),
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { ...validated, tasks };
}
