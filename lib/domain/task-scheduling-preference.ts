import type { ClockWindow, ExtractedTask } from "./types";

export const TASK_SCHEDULING_PREFERENCE_OPTIONS = [
  {
    value: "none",
    label: "No preference — PlanPilot decides",
  },
  {
    value: "early_morning",
    label: "Early morning (6–9 AM)",
    window: { start: "06:00", end: "09:00" },
  },
  {
    value: "morning",
    label: "Morning (9 AM–12 PM)",
    window: { start: "09:00", end: "12:00" },
  },
  {
    value: "afternoon",
    label: "Afternoon (12–5 PM)",
    window: { start: "12:00", end: "17:00" },
  },
  {
    value: "evening",
    label: "Evening (5–9 PM)",
    window: { start: "17:00", end: "21:00" },
  },
  {
    value: "late_evening",
    label: "Late evening (9 PM–midnight)",
    window: { start: "21:00", end: "00:00" },
  },
  {
    value: "custom",
    label: "Custom time window",
  },
] as const;

export type TaskSchedulingPreference =
  (typeof TASK_SCHEDULING_PREFERENCE_OPTIONS)[number]["value"];

export type TaskSchedulingPreferenceState =
  | TaskSchedulingPreference
  | "fixed"
  | "interpreted_required";

const DEFAULT_CUSTOM_WINDOW: ClockWindow = {
  start: "09:00",
  end: "17:00",
};

function sameWindow(left: ClockWindow, right: ClockWindow): boolean {
  return left.start === right.start && left.end === right.end;
}

export function taskHasFixedSchedule(task: ExtractedTask): boolean {
  return (
    task.taskType === "fixed_time" ||
    task.recurrence?.mode === "fixed_times"
  );
}

export function taskSchedulingPreference(
  task: ExtractedTask,
): TaskSchedulingPreferenceState {
  if (taskHasFixedSchedule(task)) return "fixed";
  const windows = task.schedulingConstraints?.preferredTimeWindows;
  if (!windows?.length) {
    return task.schedulingConstraints?.allowedTimeWindows?.length
      ? "interpreted_required"
      : "none";
  }
  if (windows.length !== 1) return "custom";
  const preset = TASK_SCHEDULING_PREFERENCE_OPTIONS.find(
    (option) => option.value !== "none" && option.value !== "custom" &&
      sameWindow(option.window, windows[0]),
  );
  return preset?.value ?? "custom";
}

function withoutEmptyConstraints(
  constraints: ExtractedTask["schedulingConstraints"],
): ExtractedTask["schedulingConstraints"] {
  if (!constraints) return undefined;
  return Object.values(constraints).some((value) => value !== undefined)
    ? constraints
    : undefined;
}

export function setTaskSchedulingPreference(
  task: ExtractedTask,
  preference: TaskSchedulingPreference,
): ExtractedTask["schedulingConstraints"] {
  if (taskHasFixedSchedule(task)) return task.schedulingConstraints;
  const existing = task.schedulingConstraints;
  if (preference === "none") {
    const remaining = { ...existing };
    delete remaining.preferredTimeWindows;
    return withoutEmptyConstraints(remaining);
  }
  if (preference === "custom") {
    return {
      ...existing,
      preferredTimeWindows:
        existing?.preferredTimeWindows?.length === 1
          ? existing.preferredTimeWindows
          : [DEFAULT_CUSTOM_WINDOW],
    };
  }
  const option = TASK_SCHEDULING_PREFERENCE_OPTIONS.find(
    (candidate) => candidate.value === preference,
  );
  return option && "window" in option
    ? { ...existing, preferredTimeWindows: [option.window] }
    : existing;
}

export function setCustomTaskSchedulingWindow(
  task: ExtractedTask,
  window: ClockWindow,
): ExtractedTask["schedulingConstraints"] {
  if (taskHasFixedSchedule(task) || window.start === window.end) {
    return task.schedulingConstraints;
  }
  return {
    ...task.schedulingConstraints,
    preferredTimeWindows: [window],
  };
}
