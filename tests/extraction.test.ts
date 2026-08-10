import { describe, expect, it } from "vitest";
import { extractionResultSchema } from "../lib/domain/extraction-schema";
import { MockTaskExtractionProvider } from "../lib/providers/mock-extraction";
import { recoverExplicitOverdueTasks } from "../lib/providers/overdue-recovery";
import { recoverTimedRecurrences } from "../lib/providers/recurrence-recovery";
import { TaskExtractionError } from "../lib/providers/task-extraction";
import { extractWithRepair } from "../lib/providers/validated-extraction";
import { task } from "./fixtures";

const input = {
  currentLocalDate: "2026-07-30",
  timeZone: "America/Los_Angeles",
};

describe("extraction validation and mock interpretation", () => {
  it("does not invent a deadline", async () => {
    const result = await new MockTaskExtractionProvider().extractTasks({
      ...input,
      text: "Finish the essay soon.",
    });
    expect(result.tasks[0].dueDate).toBeUndefined();
    expect(result.tasks[0].missingInformation).toContain(
      "No deadline was stated",
    );
    expect(result.tasks[0]).toMatchObject({
      effortEstimateSource: "heuristic",
      estimatedMinutes: 90,
    });
  });

  it("preserves stated effort and keeps the useful session within the estimate", async () => {
    const result = await new MockTaskExtractionProvider().extractTasks({
      ...input,
      text: "Email the advisor, 10 minutes.",
    });
    expect(result.tasks[0]).toMatchObject({
      estimatedMinutes: 10,
      minimumSessionMinutes: 10,
      effortEstimateSource: "stated",
      effortEstimateRationale: "Used the duration stated in the source text.",
    });
  });

  it("distinguishes a fixed event from a deadline", async () => {
    const result = await new MockTaskExtractionProvider().extractTasks({
      ...input,
      text: "Doctor appointment Tuesday at 3 PM.\nComplete homework by Tuesday at 3 PM.",
    });
    expect(result.tasks[0].taskType).toBe("fixed_time");
    expect(result.tasks[0].fixedStartAt).toBeDefined();
    expect(result.tasks[0].dueDate).toBeUndefined();
    expect(result.tasks[1].taskType).toBe("flexible");
    expect(result.tasks[1].dueDate).toBe("2026-08-04");
    expect(result.tasks[1].dueTime).toBe("15:00");
  });

  it("removes duplicate tasks caused by repeated wording", async () => {
    const result = await new MockTaskExtractionProvider().extractTasks({
      ...input,
      text: "Return library books by Friday.\nReturn library books by Friday.",
    });
    expect(result.tasks).toHaveLength(1);
  });

  it("separates informational statements", async () => {
    const result = await new MockTaskExtractionProvider().extractTasks({
      ...input,
      text: "FYI: The library entrance moved to Oak Street.",
    });
    expect(result.tasks).toHaveLength(0);
    expect(result.ignoredStatements).toHaveLength(1);
  });

  it("recognizes dates placed directly next to responsibilities", async () => {
    const result = await new MockTaskExtractionProvider().extractTasks({
      ...input,
      text: "Submit biology lab 08/15/2026\nChemistry exam — Aug 18",
    });
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0]).toMatchObject({
      title: "Submit biology lab",
      dueDate: "2026-08-15",
    });
    expect(result.tasks[1]).toMatchObject({
      title: "Chemistry exam",
      dueDate: "2026-08-18",
    });
  });

  it("raises priority as a task approaches its deadline", async () => {
    const result = await new MockTaskExtractionProvider().extractTasks({
      ...input,
      text: [
        "Submit timesheet 7/30/2026",
        "Return library books 8/1/2026",
        "Car oil change Aug 20",
      ].join("\n"),
    });
    expect(result.tasks.map((task) => task.priority)).toEqual([
      "urgent",
      "high",
      "medium",
    ]);
  });

  it("keeps a dated responsibility even without a known task keyword", async () => {
    const result = await new MockTaskExtractionProvider().extractTasks({
      ...input,
      text: "Car oil change Aug 20",
    });
    expect(result.tasks[0]).toMatchObject({
      title: "Car oil change",
      dueDate: "2026-08-20",
    });
  });

  it("filters noise instead of converting every fragment into a task", async () => {
    const result = await new MockTaskExtractionProvider().extractTasks({
      ...input,
      text: [
        "Hi Zach,",
        "Subject: Weekly updates",
        "The office is closed Friday.",
        "banana",
        "https://example.com/context",
        "Submit the expense report Friday.",
        "Thanks,",
      ].join("\n"),
    });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].title).toBe("Submit the expense report");
    expect(result.ignoredStatements).toHaveLength(6);
  });

  it("keeps actionable reminders and ignores informational reminders", async () => {
    const result = await new MockTaskExtractionProvider().extractTasks({
      ...input,
      text: "Reminder: submit timesheet Friday\nReminder: office closed Friday",
    });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].title).toBe("submit timesheet");
    expect(result.ignoredStatements).toHaveLength(1);
    expect(result.ignoredStatements[0].sourceText).toContain("office closed");
  });

  it("extracts Northwestern-style overdue checklist items as urgent tasks", async () => {
    const overdueInput = {
      currentLocalDate: "2026-08-09",
      timeZone: "America/Los_Angeles",
      text: [
        "Review weeks 1-4 of Before the Arch content (optional) 8/03/26(OVERDUE)",
        "Read your early-August Purple Prep email 8/04/26(OVERDUE)",
        "Add parent/guardian authorized payer to your student account on CAESAR (optional) 8/08/26(OVERDUE)",
      ].join("\n"),
    };
    const result = await new MockTaskExtractionProvider().extractTasks(overdueInput);

    expect(result.tasks).toHaveLength(3);
    expect(result.tasks.map((task) => task.dueDate)).toEqual([
      "2026-08-03",
      "2026-08-04",
      "2026-08-08",
    ]);
    expect(result.tasks.every((task) => task.priority === "urgent")).toBe(true);
    expect(result.tasks.every((task) => !/overdue/i.test(task.title))).toBe(true);
  });

  it("recovers a concrete overdue line when an AI provider incorrectly ignores it", async () => {
    const overdueLine = "Read your early-August Purple Prep email 8/04/26(OVERDUE)";
    const result = await recoverExplicitOverdueTasks(
      {
        currentLocalDate: "2026-08-09",
        timeZone: "America/Los_Angeles",
        text: overdueLine,
      },
      {
        tasks: [],
        ignoredStatements: [
          { sourceText: overdueLine, reason: "Status update." },
        ],
      },
    );

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      title: "Read your early-August Purple Prep email",
      dueDate: "2026-08-04",
      priority: "urgent",
    });
    expect(result.ignoredStatements).toHaveLength(0);
  });

  it("ignores standalone dates and random words", async () => {
    const result = await new MockTaskExtractionProvider().extractTasks({
      ...input,
      text: "8/15/2026\nFriday\nmiscellaneous",
    });
    expect(result.tasks).toHaveLength(0);
    expect(result.ignoredStatements).toHaveLength(3);
  });

  it("represents a finite weekly quota", async () => {
    const result = await new MockTaskExtractionProvider().extractTasks({
      ...input,
      text: "Go to the gym four times this week, 45 minutes each.",
    });
    expect(result.tasks[0].taskType).toBe("recurring_goal");
    expect(result.tasks[0].recurrence?.count).toBe(4);
    expect(result.tasks[0].estimatedMinutes).toBe(45);
  });

  it("keeps a split daily recurrence as one timed routine", async () => {
    const source =
      "Take medication every day at 8 AM, but Tuesdays and Thursdays at 10 AM.";
    const result = await new MockTaskExtractionProvider().extractTasks({
      ...input,
      text: source,
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.ignoredStatements).toHaveLength(0);
    expect(result.tasks[0]).toMatchObject({
      title: "Take medication",
      taskType: "recurring_goal",
      dueDate: undefined,
      recurrence: {
        frequency: "daily",
        mode: "fixed_times",
        timeRules: [
          {
            daysOfWeek: [
              "monday",
              "wednesday",
              "friday",
              "saturday",
              "sunday",
            ],
            time: "08:00",
          },
          { daysOfWeek: ["tuesday", "thursday"], time: "10:00" },
        ],
      },
    });
  });

  it("recovers an explicit split recurrence when an AI provider ignores it", async () => {
    const source =
      "Practice piano every day at 6 PM, except weekends at 10 AM.";
    const result = await recoverTimedRecurrences(
      { ...input, text: source },
      {
        tasks: [],
        ignoredStatements: [{ sourceText: source, reason: "Extra wording." }],
      },
    );

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      title: "Practice piano",
      recurrence: {
        mode: "fixed_times",
        timeRules: [
          { daysOfWeek: ["saturday", "sunday"], time: "10:00" },
          {
            daysOfWeek: [
              "monday",
              "tuesday",
              "wednesday",
              "thursday",
              "friday",
            ],
            time: "18:00",
          },
        ],
      },
    });
    expect(result.ignoredStatements).toHaveLength(0);
  });

  it("preserves ambiguous recurrence wording for review instead of treating it as noise", async () => {
    const result = await new MockTaskExtractionProvider().extractTasks({
      ...input,
      text: "Exercise every day at 8 except holidays.",
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.ignoredStatements).toHaveLength(0);
    expect(result.tasks[0]).toMatchObject({
      title: "Exercise",
      taskType: "recurring_goal",
      reviewRequired: true,
      approved: false,
    });
    expect(result.tasks[0].missingInformation).toEqual(
      expect.arrayContaining([
        "Clarify AM or PM for the recurring time",
        "Clarify the unsupported exception: except holidays",
      ]),
    );
  });

  it("validates multiple exact occurrences on the same recurring day", async () => {
    const result = await new MockTaskExtractionProvider().extractTasks({
      ...input,
      text: "Take medication every day at 8 AM and 8 PM.",
    });

    expect(result.tasks[0].recurrence?.timeRules).toEqual([
      { daysOfWeek: [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
      ], time: "08:00" },
      { daysOfWeek: [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
      ], time: "20:00" },
    ]);
  });

  it("rejects invalid structured output", () => {
    expect(() =>
      extractionResultSchema.parse({
        tasks: [{ title: "" }],
        ignoredStatements: [],
      }),
    ).toThrow();
  });

  it("rejects a minimum session longer than total estimated effort", () => {
    expect(() =>
      extractionResultSchema.parse({
        tasks: [
          task({
            id: "invalid-effort",
            title: "Invalid effort",
            estimatedMinutes: 20,
            minimumSessionMinutes: 30,
          }),
        ],
        ignoredStatements: [],
      }),
    ).toThrow();
  });

  it("retries one invalid provider result and accepts a repaired result", async () => {
    let calls = 0;
    const valid = {
      tasks: [task({ id: "task-1", title: "Valid task" })],
      ignoredStatements: [],
    };
    const result = await extractWithRepair(async (repair) => {
      calls += 1;
      if (!repair) return { tasks: [{ title: "" }], ignoredStatements: [] };
      expect(repair).toContain("failed validation");
      return valid;
    });
    expect(calls).toBe(2);
    expect(result.tasks[0].title).toBe("Valid task");
  });

  it("returns a useful typed error after a failed repair", async () => {
    await expect(
      extractWithRepair(async () => ({
        tasks: [{ title: "" }],
        ignoredStatements: [],
      })),
    ).rejects.toMatchObject({
      code: "INVALID_PROVIDER_OUTPUT",
    } satisfies Partial<TaskExtractionError>);
  });
});
