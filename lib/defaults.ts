import type { SchedulingPreferences } from "@/lib/domain/types";

export const DEFAULT_PREFERENCES: SchedulingPreferences = {
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
