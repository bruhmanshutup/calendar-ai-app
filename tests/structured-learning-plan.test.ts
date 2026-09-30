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

const ANCHORED_PLAN = PLAN.replace(
  "☐ Day 1: Read the course overview and skim the syllabus.",
  "☐ This Monday: Read the course overview and skim the syllabus.",
);

function sixtyItemPlan(): string {
  return Array.from({ length: 12 }, (_, weekIndex) => {
    const week = weekIndex + 1;
    const rows = Array.from({ length: 5 }, (_, dayIndex) => {
      const day = dayIndex + 1;
      const label = week === 1 && day === 1 ? "This Monday" : `Day ${day}`;
      return `☐ ${label}: Complete electronics cooling exercise ${week}.${day}.`;
    }).join("\n");
    return `Week ${week} – Electronics Cooling Topic ${week}
Goal: Build cooling-design knowledge.
Daily checklist:
${rows}`;
  }).join("\n");
}

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
  it.each([
    "PLAN STARTS NEXT TUESDAY",
    "Plan starts on next Tuesday.",
    "The plan begins September 8, 2026",
    "Plan start: 2026-09-08",
  ])("anchors numbered flexible checklist rows from %s", (header) => {
    const text = `${header}\n${PLAN}`;
    const recovered = recoverStructuredLearningPlan(
      { ...input, text, currentLocalDate: "2026-09-05" },
      collapsedResult,
    );
    expect(recovered.tasks).toHaveLength(6);
    for (const task of recovered.tasks) {
      expect(task).toMatchObject({
        taskType: "flexible",
        sequence: { anchorDate: "2026-09-08" },
        approved: true,
        reviewRequired: false,
        missingInformation: [],
      });
      expect(task.dueDate).toBeUndefined();
      expect(task.recurrence).toBeUndefined();
      const evidence = task.fieldProvenance?.find(
        (entry) => entry.path === "sequence.anchorDate",
      )?.evidence?.[0];
      expect(evidence).toBeDefined();
      expect(text.slice(evidence!.start, evidence!.end)).toBe(evidence!.quote);
      expect(evidence!.end).toBeLessThanOrEqual(header.length);
    }
  });

  it("does not use an ambiguous plan start or a tutorial date as an anchor", () => {
    for (const text of [
      `PLAN STARTS SOMETIME NEXT WEEK\n${PLAN}`,
      PLAN.replace("https://example.com/heat", "https://example.com/heat\nPlan starts next Tuesday"),
    ]) {
      const recovered = recoverStructuredLearningPlan({ ...input, text }, collapsedResult);
      expect(recovered.tasks.every((task) => !task.sequence?.anchorDate && task.reviewRequired)).toBe(true);
    }
  });

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

  it("recognizes weekday checklist labels as plan days and retains exact source spans", () => {
    const weekdayPlan = `Week 1 – Start
Daily checklist:
☐ This Monday: Begin the course.
☐ Tuesday: Continue the course.
☐ Wed: Complete the first exercise.
Week 2 – Continue
Daily checklist:
☐ Next Thursday: Review the exercise.`;
    const parsed = parseStructuredLearningPlan(weekdayPlan);

    expect(parsed?.items.map((item) => item.day)).toEqual([1, 2, 3, 4]);
    const first = parsed!.items[0];
    expect(weekdayPlan.slice(first.sourceStart, first.sourceEnd)).toBe(
      "☐ This Monday: Begin the course.",
    );
    expect(first).toMatchObject({
      weekdayExpression: "This Monday",
      sourceText: "☐ This Monday: Begin the course.",
    });
  });

  it("keeps the original source intact and puts indexed discovery rows in structureHint", () => {
    const prepared = prepareStructuredPlanExtractionInput(input);
    expect(prepared.text).toBe(PLAN);
    expect(prepared.text).toContain("https://example.com/heat");
    expect(prepared.structureHint).toContain("6 checklist responsibilities");
    expect(prepared.structureHint).toContain(
      "Week 2 — Electronics Cooling Basics | Day 2: Sketch the heat path from die to room air",
    );
    const first = parseStructuredLearningPlan(PLAN)!.items[0];
    expect(prepared.structureHint).toContain(
      `[${first.sourceStart},${first.sourceEnd}) Week 1`,
    );
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
          !task.approved &&
          task.reviewRequired,
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
        minimumGapDays: 1,
      },
      missingInformation: ["Choose a plan start date"],
      sourceText:
        "Week 12 — Final Portfolio Project\n☐ Day 2: Write a 1–2 page report with results and lessons learned.",
    });
    expect(recovered.tasks.at(-1)?.sequence).not.toHaveProperty("anchorDate");
  });

  it("derives one shared plan anchor from an explicit Week 1 weekday", () => {
    const anchoredInput: ExtractionInput = {
      text: ANCHORED_PLAN,
      currentLocalDate: "2026-08-29",
      timeZone: "America/Los_Angeles",
      sourceId: "learning-plan-paste",
    };
    const recovered = recoverStructuredLearningPlan(
      anchoredInput,
      collapsedResult,
    );

    expect(recovered.tasks).toHaveLength(6);
    expect(
      recovered.tasks.every(
        (task) =>
          task.sequence?.anchorDate === "2026-08-31" &&
          task.approved &&
          !task.reviewRequired &&
          task.missingInformation.length === 0,
      ),
    ).toBe(true);
    const first = recovered.tasks[0];
    expect(first.sourceSpan).toEqual({
      sourceId: "learning-plan-paste",
      start: ANCHORED_PLAN.indexOf("☐ This Monday:"),
      end:
        ANCHORED_PLAN.indexOf("☐ This Monday:") +
        "☐ This Monday: Read the course overview and skim the syllabus.".length,
      quote:
        "☐ This Monday: Read the course overview and skim the syllabus.",
    });
    expect(first.fieldProvenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "title", origin: "explicit" }),
        expect.objectContaining({
          path: "sequence.anchorDate",
          origin: "derived",
          evidence: [
            expect.objectContaining({
              quote: "This Monday",
              start: ANCHORED_PLAN.indexOf("This Monday"),
            }),
          ],
        }),
        expect.objectContaining({
          path: "estimatedMinutes",
          origin: "inferred",
        }),
      ]),
    );
  });

  it("preserves all 60 checklist rows in a 12-week plan", () => {
    const fullPlan = sixtyItemPlan();
    const fullInput: ExtractionInput = {
      text: fullPlan,
      currentLocalDate: "2026-08-29",
      timeZone: "America/Los_Angeles",
    };
    const parsed = parseStructuredLearningPlan(fullPlan);
    const prepared = prepareStructuredPlanExtractionInput(fullInput);
    const recovered = recoverStructuredLearningPlan(fullInput, {
      tasks: [],
      ignoredStatements: [],
    });

    expect(parsed?.items).toHaveLength(60);
    expect(prepared.text).toBe(fullPlan);
    expect(prepared.structureHint?.match(/^\[\d+,\d+\) Week /gm)).toHaveLength(
      60,
    );
    expect(recovered.tasks).toHaveLength(60);
    expect(recovered.tasks.at(-1)).toMatchObject({
      title: "Week 12, Day 5: Complete electronics cooling exercise 12.5",
      sequence: { anchorDate: "2026-08-31", week: 12, day: 5 },
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
