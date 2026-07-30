import { describe, expect, it } from "vitest";
import { extractionResultSchema } from "../lib/domain/extraction-schema";
import { MockTaskExtractionProvider } from "../lib/providers/mock-extraction";
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

  it("represents a finite weekly quota", async () => {
    const result = await new MockTaskExtractionProvider().extractTasks({
      ...input,
      text: "Go to the gym four times this week, 45 minutes each.",
    });
    expect(result.tasks[0].taskType).toBe("recurring_goal");
    expect(result.tasks[0].recurrence?.count).toBe(4);
    expect(result.tasks[0].estimatedMinutes).toBe(45);
  });

  it("rejects invalid structured output", () => {
    expect(() =>
      extractionResultSchema.parse({
        tasks: [{ title: "" }],
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
