import { z } from "zod";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { extractedTaskSchema, planningRulesSchema } from "./extraction-schema";
import { materializeCalculatedTimeBlock } from "./calculated-time-block";
import { withTaskClassification } from "./task-classification";
import type {
  HistoryItem,
  PlanningMode,
  PlanningRules,
  ReplanProposal,
  ScheduleProposal,
  SessionReview,
} from "./types";

export const EXTRACTION_MODES = [
  "gemini-hybrid",
  "openai-hybrid",
  "gemini-direct",
  "openai-direct",
  "local-fallback",
  // Legacy values remain readable so existing workspaces are not invalidated.
  "gemini",
  "openai",
  "local",
  "fast-local",
] as const;

export type ExtractionMode = (typeof EXTRACTION_MODES)[number];

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
  timeZone: z.string().optional(),
  schedulerVersion: z.number().int().positive().optional(),
  tasks: z.array(extractedTaskSchema).max(250),
  proposal: scheduleProposalSchema,
  importText: z.string().max(100_000),
  history: z.array(historyItemSchema).max(2_000),
  sessionReviews: z.array(sessionReviewSchema).max(2_000),
  planningMode: z.enum(["conservative", "balanced", "aggressive"]),
  planningRules: planningRulesSchema.optional(),
  extractionMode: z.enum(EXTRACTION_MODES).optional(),
  replan: z.unknown().optional(),
});

export type PersistedWorkspace = {
  version: 1;
  /** Time zone the saved plan times were calculated in. Missing means the original Pacific default. */
  timeZone?: string;
  schedulerVersion?: number;
  tasks: z.infer<typeof extractedTaskSchema>[];
  proposal: ScheduleProposal;
  importText: string;
  history: HistoryItem[];
  sessionReviews: SessionReview[];
  planningMode: PlanningMode;
  planningRules?: PlanningRules;
  extractionMode?: ExtractionMode;
  replan?: ReplanProposal;
};

export function parsePersistedWorkspace(value: unknown): PersistedWorkspace {
  const state = persistedWorkspaceSchema.parse(value) as PersistedWorkspace;
  return { ...state, tasks: state.tasks.map((task) => withTaskClassification(materializeCalculatedTimeBlock(task))) };
}

/** Time zone that workspaces saved before the timeZone field existed were planned in. */
export const LEGACY_WORKSPACE_TIME_ZONE = "America/Los_Angeles";

// Planned (future-facing) times. These keep their wall-clock time when the
// time zone changes. Moments that really happened (reviewedAt, completedAt,
// cancelledAt, history) are deliberately left alone.
const PLANNED_TIME_KEYS = new Set([
  "start",
  "end",
  "reviewAfter",
  "scheduledStart",
  "scheduledEnd",
  "dueAt",
  "fixedStartAt",
  "fixedEndAt",
  "windowStart",
  "windowEnd",
]);
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function shiftWallClock(value: string, from: string, to: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const wallClock = formatInTimeZone(date, from, "yyyy-MM-dd'T'HH:mm:ss.SSS");
  return fromZonedTime(wallClock, to).toISOString();
}

function shiftPlannedTimes(value: unknown, from: string, to: string): unknown {
  if (Array.isArray(value)) return value.map((item) => shiftPlannedTimes(item, from, to));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      typeof item === "string" && PLANNED_TIME_KEYS.has(key) && INSTANT_PATTERN.test(item)
        ? shiftWallClock(item, from, to)
        : shiftPlannedTimes(item, from, to),
    ]),
  );
}

/**
 * Moves a saved workspace to a new time zone so every planned session, break,
 * deadline, and blocked time keeps the same clock time (10:00 AM stays 10:00 AM).
 */
export function migrateWorkspaceTimeZone(state: PersistedWorkspace, timeZone: string): PersistedWorkspace {
  const from = state.timeZone ?? LEGACY_WORKSPACE_TIME_ZONE;
  if (from === timeZone) return { ...state, timeZone };
  return {
    ...state,
    timeZone,
    tasks: shiftPlannedTimes(state.tasks, from, timeZone) as PersistedWorkspace["tasks"],
    proposal: shiftPlannedTimes(state.proposal, from, timeZone) as ScheduleProposal,
    sessionReviews: shiftPlannedTimes(state.sessionReviews, from, timeZone) as SessionReview[],
    planningRules: shiftPlannedTimes(state.planningRules, from, timeZone) as PlanningRules | undefined,
    replan: shiftPlannedTimes(state.replan, from, timeZone) as ReplanProposal | undefined,
  };
}
