export type DayOfWeek =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

export type TaskPriority = "low" | "medium" | "high" | "urgent";

export type TaskCategory =
  | "school"
  | "work"
  | "health"
  | "fitness"
  | "errand"
  | "personal"
  | "other";

export type EnergyDemand = "low" | "medium" | "high";
export type TaskType = "flexible" | "fixed_time" | "recurring_goal";

export type ExtractedTask = {
  id?: string;
  title: string;
  description?: string;
  taskType: TaskType;
  dueDate?: string;
  dueTime?: string;
  dueAt?: string;
  fixedStartAt?: string;
  fixedEndAt?: string;
  estimatedMinutes?: number;
  effortEstimateSource?: "stated" | "ai" | "heuristic";
  effortEstimateRationale?: string;
  priority: TaskPriority;
  category: TaskCategory;
  energyDemand: EnergyDemand;
  splittable: boolean;
  minimumSessionMinutes?: number;
  recurrence?: {
    frequency: "daily" | "weekly" | "monthly";
    mode?: "quota" | "fixed_times";
    interval?: number;
    anchorDate?: string;
    occurrenceLimit?: number;
    count?: number;
    daysOfWeek?: DayOfWeek[];
    timeRules?: Array<{
      daysOfWeek: DayOfWeek[];
      time: string;
    }>;
    monthlyRules?: Array<
      | {
          type: "days_of_month";
          daysOfMonth: number[];
          times: string[];
        }
      | {
          type: "ordinal_weekday";
          ordinal: 1 | 2 | 3 | 4 | 5 | -1;
          dayOfWeek: DayOfWeek;
          times: string[];
        }
      | {
          type: "last_day_of_month";
          times: string[];
        }
    >;
    dateOverrides?: Array<{
      date: string;
      skip?: boolean;
      times?: string[];
    }>;
    windowStart?: string;
    windowEnd?: string;
  };
  confidence: number;
  fieldConfidence: {
    title: number;
    taskType: number;
    dueDate?: number;
    dueTime?: number;
    estimatedMinutes?: number;
    priority?: number;
    recurrence?: number;
  };
  missingInformation: string[];
  sourceText: string;
  approved?: boolean;
  reviewRequired?: boolean;
  completed?: boolean;
  completedAt?: string;
  completedMinutes?: number;
  cancelled?: boolean;
  cancelledAt?: string;
};

export type IgnoredStatement = {
  sourceText: string;
  reason: string;
};

export type ExtractionResult = {
  tasks: ExtractedTask[];
  ignoredStatements: IgnoredStatement[];
};

export type ExtractionInput = {
  text: string;
  currentLocalDate: string;
  timeZone: string;
  sourceId?: string;
};

export type TimeInterval = {
  start: string;
  end: string;
};

export type PlanningMode = "conservative" | "balanced" | "aggressive";

export type SchedulingPreferences = {
  timeZone: string;
  wakingTime: string;
  sleepingTime: string;
  preferredBlockMinutes: number;
  maximumBlockMinutes: number;
  preferredBreakMinutes: number;
  planningMode: PlanningMode;
  weekendsAllowed: boolean;
  preferredFocusWindows: Array<{ start: string; end: string }>;
  preferredRoutineWindows: Array<{ start: string; end: string }>;
};

export type ExistingSession = {
  id: string;
  taskId: string;
  title: string;
  start: string;
  end: string;
  locked: boolean;
  status:
    | "proposed"
    | "approved"
    | "completed"
    | "partial"
    | "missed"
    | "unnecessary";
};

export type ScheduleReasonCode =
  | "OVERDUE_RECOVERY"
  | "DEADLINE_RISK"
  | "PREFERRED_FOCUS_WINDOW"
  | "PREFERRED_ROUTINE_WINDOW"
  | "PRIORITY"
  | "EARLY_COMPLETION"
  | "SPLIT_TO_REDUCE_FATIGUE"
  | "RECURRING_SPACING"
  | "BUFFER_PRESERVED"
  | "LOW_ENERGY_FIT"
  | "FINAL_VALID_OPENING"
  | "STABILITY_PRESERVED"
  | "MOVED_AFTER_MISSED"
  | "FIXED_TIME";

export type PlannedSession = {
  id: string;
  taskId: string;
  title: string;
  start: string;
  end: string;
  minutes: number;
  status:
    | "proposed"
    | "approved"
    | "in_progress"
    | "completed"
    | "partial"
    | "missed"
    | "unnecessary";
  locked: boolean;
  reviewedAt?: string;
  reviewAfter?: string;
  minutesCompleted?: number;
  reasonCodes: ScheduleReasonCode[];
  explanation: string;
};

export type ScheduledBreak = {
  afterSessionId: string;
  start: string;
  end: string;
  minutes: number;
};

export type UnschedulableTask = {
  taskId: string;
  title: string;
  unscheduledMinutes: number;
  reasonCode:
    | "INSUFFICIENT_CAPACITY"
    | "NO_VALID_TIME_BEFORE_DEADLINE"
    | "MISSING_REQUIRED_INFORMATION"
    | "FIXED_TIME_CONFLICT"
    | "MINIMUM_SESSION_TOO_LARGE";
  explanation: string;
  suggestedActions: string[];
};

export type SchedulingInput = {
  windowStart: string;
  windowEnd: string;
  allowExplicitTimesOutsideAvailability?: boolean;
  tasks: ExtractedTask[];
  preferences: SchedulingPreferences;
  availability: TimeInterval[];
  unavailableEvents: TimeInterval[];
  blockedTimes: TimeInterval[];
  lockedSessions: ExistingSession[];
};

export type PlanHealth = {
  scheduledPercent: number;
  deadlinesAtRisk: number;
  unscheduledMinutes: number;
  bufferMinutesRetained: number;
  demandingFocusBlocks: number;
  fragmentedTaskIds: string[];
  recurringGoalsOnTrack: number;
  recurringGoalsBehind: number;
  summary: string;
};

export type ScheduleProposal = {
  id: string;
  sessions: PlannedSession[];
  breaks: ScheduledBreak[];
  unschedulable: UnschedulableTask[];
  planHealth: PlanHealth;
  availableMinutes: number;
  plannedMinutes: number;
  bufferMinutes: number;
};

export type ReplanChange =
  | {
      type: "remove";
      sessionId: string;
      before: ExistingSession;
      reason: string;
    }
  | {
      type: "add";
      after: PlannedSession;
      reason: string;
    }
  | {
      type: "move";
      sessionId: string;
      before: ExistingSession;
      after: PlannedSession;
      reason: string;
    };

export type ReplanProposal = {
  remainingMinutes: number;
  changes: ReplanChange[];
  preservedSessionIds: string[];
  explanation: string;
  unschedulable?: UnschedulableTask;
};

export type SessionOutcome =
  | "completed"
  | "partial"
  | "missed"
  | "unnecessary";

export type SessionReview = {
  id: string;
  sessionId: string;
  taskId: string;
  title: string;
  scheduledStart: string;
  scheduledEnd: string;
  outcome: SessionOutcome;
  plannedMinutes: number;
  completedMinutes: number;
  remainingMinutes: number;
  reviewedAt: string;
};

export type HistoryItem = {
  id: string;
  at: string;
  icon: "edit" | "calendar" | "move" | "complete";
  title: string;
  detail: string;
};
