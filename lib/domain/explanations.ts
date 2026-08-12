import type { ScheduleReasonCode } from "./types";

const EXPLANATIONS: Record<ScheduleReasonCode, string> = {
  OVERDUE_RECOVERY:
    "Placed in the earliest practical opening because its deadline has already passed.",
  DEADLINE_RISK: "Scheduled early because this task has high deadline risk.",
  PREFERRED_FOCUS_WINDOW: "Placed during your preferred focus period.",
  PREFERRED_ROUTINE_WINDOW: "Placed during your preferred routine window.",
  PRIORITY: "Given extra weight because you marked it as important.",
  EARLY_COMPLETION: "Placed earlier to leave recovery room before the deadline.",
  SPLIT_TO_REDUCE_FATIGUE:
    "Split into focused sessions to reduce fatigue and avoid a tiny remainder.",
  RECURRING_SPACING: "Spaced from other occurrences when capacity allowed.",
  BUFFER_PRESERVED: "This placement preserves time for interruptions.",
  LOW_ENERGY_FIT: "Placed in a lower-energy opening that suits this task.",
  FINAL_VALID_OPENING: "This was the final valid opening before the deadline.",
  STABILITY_PRESERVED: "Kept in place to minimize disruption.",
  MOVED_AFTER_MISSED: "Moved because the earlier session was marked missed.",
  SEQUENCE_ORDER:
    "Placed after the preceding plan step so the Week/Day progression stays in order.",
  FIXED_TIME: "Kept at the explicit fixed time from the source.",
};

export function explainReasons(reasons: ScheduleReasonCode[]): string {
  return reasons.map((reason) => EXPLANATIONS[reason]).join(" ");
}
