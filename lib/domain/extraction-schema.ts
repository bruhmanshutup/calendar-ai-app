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

export const extractedTaskSchema = z
  .object({
    id: z.string().optional(),
    title: z.string().trim().min(1).max(180),
    description: z.string().trim().max(2000).optional(),
    taskType: z.enum(["flexible", "fixed_time", "recurring_goal"]),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    dueTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    dueAt: z.string().datetime({ offset: true }).optional(),
    fixedStartAt: z.string().datetime({ offset: true }).optional(),
    fixedEndAt: z.string().datetime({ offset: true }).optional(),
    estimatedMinutes: z.number().int().positive().max(24 * 60).optional(),
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
    missingInformation: z.array(z.string().trim().min(1)).max(20),
    sourceText: z.string().trim().min(1).max(4000),
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
      !task.recurrence?.anchorDate &&
      !task.reviewRequired
    ) {
      context.addIssue({
        code: "custom",
        path: ["recurrence", "anchorDate"],
        message: "An interval recurrence needs an anchor date or review.",
      });
    }
    if (task.dueTime && !task.dueDate) {
      context.addIssue({
        code: "custom",
        path: ["dueTime"],
        message: "A due time requires a due date.",
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
});

export type ValidatedExtractionResult = z.infer<
  typeof extractionResultSchema
>;

export function validateAndDedupeExtraction(
  value: unknown,
): ValidatedExtractionResult {
  const validated = extractionResultSchema.parse(value);
  const seen = new Set<string>();
  const tasks = validated.tasks.filter((task) => {
    const key = [
      task.title.trim().toLocaleLowerCase(),
      task.taskType,
      task.dueDate ?? "",
      task.fixedStartAt ?? "",
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { ...validated, tasks };
}
