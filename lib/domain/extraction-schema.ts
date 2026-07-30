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
        frequency: z.enum(["daily", "weekly"]),
        count: z.number().int().positive().max(31).optional(),
        daysOfWeek: z.array(dayOfWeekSchema).max(7).optional(),
        windowStart: z.string().datetime({ offset: true }).optional(),
        windowEnd: z.string().datetime({ offset: true }).optional(),
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
  })
  .superRefine((task, context) => {
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
