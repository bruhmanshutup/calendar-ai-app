import { z } from "zod";
import { extractedTaskSchema, planningRulesSchema } from "./extraction-schema";
import type {
  HistoryItem,
  PlanningMode,
  PlanningRules,
  ReplanProposal,
  ScheduleProposal,
  SessionReview,
} from "./types";

const sessionStatusSchema = z.enum([
  "proposed",
  "approved",
  "in_progress",
  "completed",
  "partial",
  "missed",
  "unnecessary",
]);

const plannedSessionSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  title: z.string().min(1),
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
  minutes: z.number().int().positive(),
  status: sessionStatusSchema,
  locked: z.boolean(),
  reviewedAt: z.string().datetime({ offset: true }).optional(),
  reviewAfter: z.string().datetime({ offset: true }).optional(),
  minutesCompleted: z.number().int().min(0).optional(),
  reasonCodes: z.array(z.string()),
  explanation: z.string(),
});

const scheduleProposalSchema = z.object({
  id: z.string(),
  sessions: z.array(plannedSessionSchema),
  breaks: z.array(
    z.object({
      afterSessionId: z.string(),
      start: z.string().datetime({ offset: true }),
      end: z.string().datetime({ offset: true }),
      minutes: z.number().int().positive(),
    }),
  ),
  unschedulable: z.array(
    z.object({
      taskId: z.string(),
      title: z.string(),
      unscheduledMinutes: z.number().int().min(0),
      reasonCode: z.string(),
      explanation: z.string(),
      suggestedActions: z.array(z.string()),
    }),
  ),
  planHealth: z.object({
    scheduledPercent: z.number(),
    deadlinesAtRisk: z.number().int().min(0),
    unscheduledMinutes: z.number().int().min(0),
    bufferMinutesRetained: z.number().int().min(0),
    demandingFocusBlocks: z.number().int().min(0),
    fragmentedTaskIds: z.array(z.string()),
    recurringGoalsOnTrack: z.number().int().min(0),
    recurringGoalsBehind: z.number().int().min(0),
    summary: z.string(),
  }),
  availableMinutes: z.number().int().min(0),
  plannedMinutes: z.number().int().min(0),
  bufferMinutes: z.number().int().min(0),
});

const historyItemSchema = z.object({
  id: z.string(),
  at: z.string(),
  icon: z.enum(["edit", "calendar", "move", "complete"]),
  title: z.string(),
  detail: z.string(),
});

const sessionReviewSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  taskId: z.string(),
  title: z.string(),
  scheduledStart: z.string().datetime({ offset: true }),
  scheduledEnd: z.string().datetime({ offset: true }),
  outcome: z.enum(["completed", "partial", "missed", "unnecessary"]),
  plannedMinutes: z.number().int().positive(),
  completedMinutes: z.number().int().min(0),
  remainingMinutes: z.number().int().min(0),
  reviewedAt: z.string().datetime({ offset: true }),
});

export const persistedWorkspaceSchema = z.object({
  version: z.literal(1),
  schedulerVersion: z.number().int().positive().optional(),
  tasks: z.array(extractedTaskSchema).max(250),
  proposal: scheduleProposalSchema,
  importText: z.string().max(100_000),
  history: z.array(historyItemSchema).max(2_000),
  sessionReviews: z.array(sessionReviewSchema).max(2_000),
  planningMode: z.enum(["conservative", "balanced", "aggressive"]),
  planningRules: planningRulesSchema.optional(),
  extractionMode: z.enum(["gemini", "openai", "local", "fast-local"]).optional(),
  replan: z.unknown().optional(),
});

export type PersistedWorkspace = {
  version: 1;
  schedulerVersion?: number;
  tasks: z.infer<typeof extractedTaskSchema>[];
  proposal: ScheduleProposal;
  importText: string;
  history: HistoryItem[];
  sessionReviews: SessionReview[];
  planningMode: PlanningMode;
  planningRules?: PlanningRules;
  extractionMode?: "gemini" | "openai" | "local" | "fast-local";
  replan?: ReplanProposal;
};

export function parsePersistedWorkspace(value: unknown): PersistedWorkspace {
  return persistedWorkspaceSchema.parse(value) as PersistedWorkspace;
}
