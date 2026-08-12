import { describe, expect, it } from "vitest";
import type { ExtractionInput, ExtractionResult } from "../lib/domain/types";
import {
  parseStructuredLearningPlan,
  prepareStructuredPlanExtractionInput,
  recoverStructuredLearningPlan,
} from "../lib/providers/structured-plan-recovery";

const PLAN = `12-Week Electronics Cooling Learning Plan
For a high-school graduate preparing for engineering school
Week 1 – Heat Transfer Fundamentals
Goal: Understand conduction, convection, and radiation.
Tutorial links:
MIT OpenCourseWare — https://example.com/heat
Daily checklist:
☐ Day 1: Read the course overview and skim the syllabus.
☐ Day 2: Watch intro videos on conduction and convection.
Week 2 – Electronics Cooling Basics
Goal: Learn heat sinks, fans, and airflow paths.
Daily checklist:
☐ Day 1: Identify cooling parts in a laptop teardown video.
☐ Day 2: Sketch the heat path from die to room air.
Week 12 – Final Portfolio Project
Goal: Package the work into a mini engineering portfolio.
Daily checklist:
☐ Day 1: Re-run the improved design case.
☐ Day 2: Write a 1–2 page report with results and lessons learned.`;

const input: ExtractionInput = {
  text: PLAN,
  currentLocalDate: "2026-08-12",
  timeZone: "America/Los_Angeles",
};

const collapsedResult: ExtractionResult = {
  tasks: [
    {
      id: "ai-plan",
      title: "Complete 12-Week Electronics Cooling Learning Plan",
      taskType: "recurring_goal",
      estimatedMinutes: 60,
      effortEstimateSource: "ai",
      effortEstimateRationale: "Assumed an hour for each checklist item.",
      priority: "medium",
      category: "school",
      energyDemand: "high",
      splittable: false,
      minimumSessionMinutes: 30,
      recurrence: { frequency: "weekly", mode: "quota", count: 5 },
      confidence: 0.7,
      fieldConfidence: {
        title: 0.9,
        taskType: 0.7,
        estimatedMinutes: 0.7,
        priority: 0.7,
        recurrence: 0.6,
      },
      missingInformation: ["Choose a start date"],
      sourceText: "12-Week Electronics Cooling Learning Plan",
      approved: false,
      reviewRequired: true,
    },
    {
      id: "ai-checklist",
      title: "Daily checklist",
      taskType: "recurring_goal",
      estimatedMinutes: 45,
      effortEstimateSource: "heuristic",
      effortEstimateRationale: "Used a conservative default.",
      priority: "medium",
      category: "personal",
      energyDemand: "medium",
      splittable: false,
      minimumSessionMinutes: 30,
      recurrence: { frequency: "daily", mode: "fixed_times" },
      confidence: 0.5,
      fieldConfidence: {
        title: 0.8,
        taskType: 0.5,
        estimatedMinutes: 0.4,
        priority: 0.5,
        recurrence: 0.4,
      },
      missingInformation: ["Add an exact recurring time"],
      sourceText: "Daily checklist:",
      approved: false,
      reviewRequired: true,
    },
  ],
  ignoredStatements: [],
};

describe("structured learning plan recovery", () => {
  it("recognizes week sections and each numbered checklist action", () => {
    const parsed = parseStructuredLearningPlan(PLAN);
    expect(parsed).toMatchObject({ weekCount: 3 });
    expect(parsed?.items).toHaveLength(6);
    expect(parsed?.items.at(-1)).toMatchObject({
      week: 12,
      day: 2,
      action: "Write a 1–2 page report with results and lessons learned",
    });
  });

  it("makes the AI input explicitly enumerate the expected responsibilities", () => {
    const prepared = prepareStructuredPlanExtractionInput(input);
    expect(prepared.text).toContain("6 checklist responsibilities");
    expect(prepared.text).toContain(
      "Week 2 — Electronics Cooling Basics | Day 2: Sketch the heat path from die to room air",
    );
    expect(prepared.text).not.toContain("https://example.com/heat");
  });

  it("replaces collapsed plan and checklist tasks with each actionable item", () => {
    const recovered = recoverStructuredLearningPlan(input, collapsedResult);
    expect(recovered.tasks).toHaveLength(6);
    expect(recovered.tasks.map((task) => task.title)).toEqual([
      "Week 1, Day 1: Read the course overview and skim the syllabus",
      "Week 1, Day 2: Watch intro videos on conduction and convection",
      "Week 2, Day 1: Identify cooling parts in a laptop teardown video",
      "Week 2, Day 2: Sketch the heat path from die to room air",
      "Week 12, Day 1: Re-run the improved design case",
      "Week 12, Day 2: Write a 1–2 page report with results and lessons learned",
    ]);
    expect(
      recovered.tasks.every(
        (task) =>
          task.taskType === "flexible" &&
          !task.recurrence &&
          !task.dueDate &&
          task.approved &&
          !task.reviewRequired,
      ),
    ).toBe(true);
    expect(recovered.tasks.at(-1)).toMatchObject({
      estimatedMinutes: 90,
      category: "school",
      sequence: {
        groupId: expect.stringMatching(/^structured-plan-/),
        order: 12002,
        week: 12,
        day: 2,
        anchorDate: "2026-08-12",
        minimumGapDays: 1,
      },
      sourceText:
        "Week 12 — Final Portfolio Project\n☐ Day 2: Write a 1–2 page report with results and lessons learned.",
    });
  });

  it("preserves an item-specific AI effort estimate when one was returned", () => {
    const itemSpecific: ExtractionResult = {
      tasks: [
        {
          ...collapsedResult.tasks[0],
          title: "Read the course overview and skim the syllabus",
          sourceText: "Week 1 — Heat Transfer Fundamentals | Day 1: Read the course overview and skim the syllabus",
          taskType: "flexible",
          recurrence: undefined,
          estimatedMinutes: 20,
          effortEstimateSource: "ai",
          effortEstimateRationale: "A brief overview and syllabus skim.",
        },
      ],
      ignoredStatements: [],
    };
    const recovered = recoverStructuredLearningPlan(input, itemSpecific);
    expect(recovered.tasks[0]).toMatchObject({
      estimatedMinutes: 20,
      effortEstimateSource: "ai",
      effortEstimateRationale: "A brief overview and syllabus skim.",
    });
  });
});
