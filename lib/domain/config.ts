import type { PlanningMode } from "./types";

export const SCHEDULER_INCREMENT_MINUTES = 15;

export const PLANNING_MODE_CONFIG: Record<
  PlanningMode,
  {
    bufferRatio: number;
    demandingBlockLimit: number;
    earlyCompletionWeight: number;
    densityWeight: number;
  }
> = {
  conservative: {
    bufferRatio: 0.25,
    demandingBlockLimit: 2,
    earlyCompletionWeight: 22,
    densityWeight: 0,
  },
  balanced: {
    bufferRatio: 0.15,
    demandingBlockLimit: 3,
    earlyCompletionWeight: 14,
    densityWeight: 6,
  },
  aggressive: {
    bufferRatio: 0.05,
    demandingBlockLimit: 5,
    earlyCompletionWeight: 7,
    densityWeight: 14,
  },
};

export const PRIORITY_WEIGHT = {
  low: 0,
  medium: 18,
  high: 36,
  urgent: 52,
} as const;

