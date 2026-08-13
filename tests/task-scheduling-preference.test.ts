import { describe, expect, it } from "vitest";
import {
  setCustomTaskSchedulingWindow,
  setTaskSchedulingPreference,
  taskSchedulingPreference,
} from "../lib/domain/task-scheduling-preference";
import { task } from "./fixtures";

describe("per-task scheduling preferences", () => {
  it("recognizes every built-in time-of-day preset", () => {
    const windows = [
      ["early_morning", "06:00", "09:00"],
      ["morning", "09:00", "12:00"],
      ["afternoon", "12:00", "17:00"],
      ["evening", "17:00", "21:00"],
      ["late_evening", "21:00", "00:00"],
    ] as const;

    windows.forEach(([preference, start, end]) => {
      const source = task({ id: preference, title: preference });
      const schedulingConstraints = setTaskSchedulingPreference(
        source,
        preference,
      );
      expect(schedulingConstraints?.preferredTimeWindows).toEqual([
        { start, end },
      ]);
      expect(
        taskSchedulingPreference({ ...source, schedulingConstraints }),
      ).toBe(preference);
    });
  });

  it("preserves hard constraints and spacing while changing a soft preference", () => {
    const source = task({
      id: "dentist",
      title: "Call dentist",
      schedulingConstraints: {
        allowedTimeWindows: [{ start: "09:00", end: "17:00" }],
        preferredTimeWindows: [{ start: "10:00", end: "11:00" }],
        avoidConsecutiveDays: true,
        sessionCount: 2,
      },
    });

    expect(setTaskSchedulingPreference(source, "afternoon")).toEqual({
      allowedTimeWindows: [{ start: "09:00", end: "17:00" }],
      preferredTimeWindows: [{ start: "12:00", end: "17:00" }],
      avoidConsecutiveDays: true,
      sessionCount: 2,
    });
  });

  it("shows an interpreted hard window instead of incorrectly saying no preference", () => {
    const dentist = task({
      id: "dentist-hours",
      title: "Call dentist",
      schedulingConstraints: {
        allowedTimeWindows: [{ start: "09:00", end: "17:00" }],
      },
    });

    expect(taskSchedulingPreference(dentist)).toBe("interpreted_required");

    const withPreference = {
      ...dentist,
      schedulingConstraints: setTaskSchedulingPreference(dentist, "afternoon"),
    };
    expect(taskSchedulingPreference(withPreference)).toBe("afternoon");
    expect(withPreference.schedulingConstraints).toEqual({
      allowedTimeWindows: [{ start: "09:00", end: "17:00" }],
      preferredTimeWindows: [{ start: "12:00", end: "17:00" }],
    });

    const reset = {
      ...withPreference,
      schedulingConstraints: setTaskSchedulingPreference(
        withPreference,
        "none",
      ),
    };
    expect(taskSchedulingPreference(reset)).toBe("interpreted_required");
    expect(reset.schedulingConstraints).toEqual({
      allowedTimeWindows: [{ start: "09:00", end: "17:00" }],
    });
  });

  it("removes only the optional preference when PlanPilot should decide", () => {
    const source = task({
      id: "workout",
      title: "Workout",
      schedulingConstraints: {
        preferredTimeWindows: [{ start: "17:00", end: "21:00" }],
        avoidConsecutiveDays: true,
      },
    });
    const schedulingConstraints = setTaskSchedulingPreference(source, "none");

    expect(schedulingConstraints).toEqual({ avoidConsecutiveDays: true });
    expect(
      setTaskSchedulingPreference(
        task({ id: "plain", title: "Plain task" }),
        "none",
      ),
    ).toBeUndefined();
  });

  it("supports imported and user-defined custom windows", () => {
    const imported = task({
      id: "gym",
      title: "Gym",
      schedulingConstraints: {
        preferredTimeWindows: [{ start: "16:00", end: "20:00" }],
      },
    });
    expect(taskSchedulingPreference(imported)).toBe("custom");
    expect(setTaskSchedulingPreference(imported, "custom")).toEqual(
      imported.schedulingConstraints,
    );

    const updated = setCustomTaskSchedulingWindow(imported, {
      start: "15:30",
      end: "18:45",
    });
    expect(updated?.preferredTimeWindows).toEqual([
      { start: "15:30", end: "18:45" },
    ]);
  });

  it("does not offer a soft preference for fixed events or fixed recurrences", () => {
    const event = task({
      id: "meeting",
      title: "Meeting",
      taskType: "fixed_time",
    });
    const routine = task({
      id: "medicine",
      title: "Take medicine",
      taskType: "recurring_goal",
      recurrence: {
        frequency: "daily",
        mode: "fixed_times",
        timeRules: [
          {
            daysOfWeek: ["monday"],
            time: "08:00",
          },
        ],
      },
    });

    expect(taskSchedulingPreference(event)).toBe("fixed");
    expect(taskSchedulingPreference(routine)).toBe("fixed");
    expect(setTaskSchedulingPreference(event, "evening")).toBeUndefined();
  });
});
