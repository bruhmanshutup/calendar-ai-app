import { describe, expect, it } from "vitest";
import type { ExtractedTask, ExtractionInput, ExtractionResult } from "../lib/domain/types";
import { decideOpenAIVerification } from "../lib/providers/verification-policy";

const input = (text: string): ExtractionInput => ({
  text,
  currentLocalDate: "2026-09-19",
  timeZone: "America/Chicago",
});

const task = (patch: Partial<ExtractedTask>): ExtractedTask => ({
  title: "Example task",
  sourceText: "Example task",
  taskType: "flexible",
  priority: "medium",
  category: "other",
  energyDemand: "medium",
  splittable: false,
  confidence: 0.95,
  fieldConfidence: { title: 0.95, taskType: 0.95 },
  missingInformation: [],
  ...patch,
});

const result = (tasks: ExtractedTask[]): ExtractionResult => ({
  tasks,
  ignoredStatements: [],
});

describe("OpenAI verification policy", () => {
  it("skips the second call for a short explicit low-risk import", () => {
    const decision = decideOpenAIVerification(
      input("Tomorrow at 9 AM, attend the staff meeting."),
      result([
        task({
          title: "Attend the staff meeting",
          taskType: "fixed_time",
          fixedStartAt: "2026-09-20T14:00:00.000Z",
          fixedEndAt: "2026-09-20T15:00:00.000Z",
          sourceText: "Tomorrow at 9 AM, attend the staff meeting.",
        }),
      ]),
      "auto",
    );

    expect(decision.shouldVerify).toBe(false);
    expect(decision.mode).toBe("auto");
    expect(decision.reasons).toContain("low-risk-explicit-input");
  });

  it("verifies corrections and dependency chains", () => {
    const decision = decideOpenAIVerification(
      input(
        "The meeting moved from Tuesday to Friday. Finish the draft before it; if the client replies, revise it instead.",
      ),
      result([
        task({
          title: "Finish the draft",
          confidence: 0.78,
          dependencies: [
            { relation: "before", targetTitle: "Client meeting" },
          ],
          conditionalRules: [
            { condition: "client replies", effect: "revise the draft" },
          ],
        }),
      ]),
      "auto",
    );

    expect(decision.shouldVerify).toBe(true);
    expect(decision.riskScore).toBeGreaterThanOrEqual(3);
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        "correction-or-cancellation-language",
        "conditional-language",
        "1-high-risk-task",
      ]),
    );
  });

  it("treats explicit settings as stable overrides", () => {
    const draft = result([task({ title: "One task" })]);
    expect(decideOpenAIVerification(input("Do one thing."), draft, "1")).toMatchObject({
      shouldVerify: true,
      mode: "always",
    });
    expect(decideOpenAIVerification(input("Do one thing."), draft, "0")).toMatchObject({
      shouldVerify: false,
      mode: "off",
      reasons: ["verification-disabled"],
    });
  });

  it("raises risk for table imports with many responsibilities", () => {
    const decision = decideOpenAIVerification(
      input(
        "| Time | Course | Room |\n| --- | --- | --- |\n| 9 AM | Chemistry | Lab 2 |\n| 11 AM | Physics | Room 4 |\n| 1 PM | Design | Studio |\n| 3 PM | Seminar | Hall |",
      ),
      result(
        Array.from({ length: 4 }, (_, index) =>
          task({ title: `Class ${index + 1}`, taskType: "fixed_time" }),
        ),
      ),
      "auto",
    );

    expect(decision.shouldVerify).toBe(true);
    expect(decision.reasons).toEqual(
      expect.arrayContaining(["structured-table-input", "multiple-responsibilities"]),
    );
  });

  it("verifies recurring schedules even when the draft looks confident", () => {
    const decision = decideOpenAIVerification(
      input("Review calculus every Monday and Wednesday at 10 AM through finals."),
      result([
        task({
          title: "Review calculus",
          taskType: "recurring_goal",
          recurrence: {
            frequency: "weekly",
            mode: "fixed_times",
            daysOfWeek: ["monday", "wednesday"],
            timeRules: [{ daysOfWeek: ["monday", "wednesday"], time: "10:00" }],
          },
        }),
      ]),
      "auto",
    );

    expect(decision.shouldVerify).toBe(true);
    expect(decision.reasons).toContain("1-high-risk-task");
  });
});
