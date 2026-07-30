import type {
  ExistingSession,
  ExtractedTask,
  SchedulingInput,
  SchedulingPreferences,
} from "@/lib/domain/types";

export const DEMO_PREFERENCES: SchedulingPreferences = {
  timeZone: "America/Los_Angeles",
  wakingTime: "07:00",
  sleepingTime: "23:00",
  preferredBlockMinutes: 45,
  maximumBlockMinutes: 90,
  preferredBreakMinutes: 10,
  planningMode: "balanced",
  weekendsAllowed: true,
  preferredFocusWindows: [{ start: "16:00", end: "19:00" }],
  preferredRoutineWindows: [{ start: "17:00", end: "20:30" }],
};

export const DEMO_TASKS: ExtractedTask[] = [
  {
    id: "chemistry",
    title: "Review for chemistry exam",
    description: "Chapters 7–9, practice problems, and reaction patterns.",
    taskType: "flexible",
    dueDate: "2026-07-31",
    dueTime: "17:00",
    dueAt: "2026-08-01T00:00:00.000Z",
    estimatedMinutes: 180,
    priority: "urgent",
    category: "school",
    energyDemand: "high",
    splittable: true,
    minimumSessionMinutes: 30,
    confidence: 0.97,
    fieldConfidence: {
      title: 0.99,
      taskType: 0.98,
      dueDate: 0.99,
      dueTime: 0.97,
      estimatedMinutes: 0.72,
      priority: 0.93,
    },
    missingInformation: ["Confirm effort estimate"],
    sourceText:
      "Chemistry exam Friday at 5 PM — review chapters 7–9 and practice problems. About 3 hours.",
    approved: true,
    reviewRequired: false,
  },
  {
    id: "essay",
    title: "Draft comparative literature essay",
    description: "Write the first complete draft and leave revision time.",
    taskType: "flexible",
    dueDate: "2026-08-03",
    estimatedMinutes: 120,
    priority: "high",
    category: "school",
    energyDemand: "high",
    splittable: true,
    minimumSessionMinutes: 30,
    confidence: 0.91,
    fieldConfidence: {
      title: 0.98,
      taskType: 0.98,
      dueDate: 0.95,
      estimatedMinutes: 0.68,
      priority: 0.83,
    },
    missingInformation: [],
    sourceText:
      "Comparative literature essay due Monday. Draft should take around 2 hours.",
    approved: true,
    reviewRequired: false,
  },
  {
    id: "gym",
    title: "Gym session",
    taskType: "recurring_goal",
    estimatedMinutes: 45,
    priority: "medium",
    category: "fitness",
    energyDemand: "medium",
    splittable: false,
    minimumSessionMinutes: 45,
    recurrence: {
      frequency: "weekly",
      count: 4,
      windowStart: "2026-07-27T07:00:00.000Z",
      windowEnd: "2026-08-03T06:59:59.000Z",
    },
    confidence: 0.96,
    fieldConfidence: {
      title: 0.96,
      taskType: 0.99,
      estimatedMinutes: 0.61,
      priority: 0.52,
      recurrence: 0.99,
    },
    missingInformation: [],
    sourceText: "Go to the gym four times this week, about 45 minutes each.",
    approved: true,
    reviewRequired: false,
  },
  {
    id: "library",
    title: "Return library books",
    taskType: "flexible",
    dueDate: "2026-07-31",
    estimatedMinutes: 30,
    priority: "medium",
    category: "errand",
    energyDemand: "low",
    splittable: false,
    minimumSessionMinutes: 30,
    confidence: 0.94,
    fieldConfidence: {
      title: 0.99,
      taskType: 0.93,
      dueDate: 0.97,
      estimatedMinutes: 0.57,
      priority: 0.55,
    },
    missingInformation: [],
    sourceText: "Return library books by Friday.",
    approved: true,
    reviewRequired: false,
  },
  {
    id: "advisor",
    title: "Advisor appointment",
    taskType: "fixed_time",
    fixedStartAt: "2026-07-30T22:00:00.000Z",
    estimatedMinutes: 60,
    priority: "medium",
    category: "school",
    energyDemand: "medium",
    splittable: false,
    confidence: 0.66,
    fieldConfidence: {
      title: 0.97,
      taskType: 0.99,
      estimatedMinutes: 0.42,
      priority: 0.5,
    },
    missingInformation: ["Fixed event end time"],
    sourceText: "Advisor appointment Thursday at 3 PM.",
    approved: false,
    reviewRequired: true,
  },
];

export const DEMO_SCHEDULING_BASE: Omit<
  SchedulingInput,
  "tasks" | "preferences"
> = {
  windowStart: "2026-07-30T14:00:00.000Z",
  windowEnd: "2026-08-03T06:00:00.000Z",
  availability: [
    { start: "2026-07-30T22:00:00.000Z", end: "2026-07-31T03:00:00.000Z" },
    { start: "2026-07-31T22:00:00.000Z", end: "2026-08-01T03:00:00.000Z" },
    { start: "2026-08-01T17:00:00.000Z", end: "2026-08-01T21:00:00.000Z" },
    { start: "2026-08-02T17:00:00.000Z", end: "2026-08-02T21:00:00.000Z" },
  ],
  unavailableEvents: [
    { start: "2026-07-30T23:30:00.000Z", end: "2026-07-31T00:30:00.000Z" },
    { start: "2026-07-31T22:30:00.000Z", end: "2026-07-31T23:30:00.000Z" },
  ],
  blockedTimes: [
    { start: "2026-08-01T19:00:00.000Z", end: "2026-08-01T20:00:00.000Z" },
  ],
  lockedSessions: [],
};

export const MISSED_DEMO_SESSION: ExistingSession = {
  id: "missed-chemistry-tuesday",
  taskId: "chemistry",
  title: "Review for chemistry exam",
  start: "2026-07-29T01:00:00.000Z",
  end: "2026-07-29T01:45:00.000Z",
  locked: false,
  status: "missed",
};

export type HistoryItem = {
  id: string;
  at: string;
  icon: "move" | "edit" | "approve" | "calendar" | "complete";
  title: string;
  detail: string;
};

export const DEMO_HISTORY: HistoryItem[] = [
  {
    id: "history-1",
    at: "Today, 8:14 AM",
    icon: "edit",
    title: "Essay deadline changed",
    detail: "Moved from August 1 to August 3.",
  },
  {
    id: "history-2",
    at: "Yesterday, 7:42 PM",
    icon: "move",
    title: "Chemistry review needs a new time",
    detail: "Tuesday’s 6:00 PM session was marked missed.",
  },
  {
    id: "history-3",
    at: "Monday, 5:30 PM",
    icon: "complete",
    title: "Gym session completed",
    detail: "45 of 45 minutes completed.",
  },
  {
    id: "history-4",
    at: "Monday, 9:06 AM",
    icon: "approve",
    title: "Four tasks approved",
    detail: "Uncertain fields were reviewed before scheduling.",
  },
];

