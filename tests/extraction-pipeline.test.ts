import { describe, expect, it, vi } from "vitest";
import type {
  ExtractedTask,
  ExtractionInput,
  ExtractionResult,
} from "../lib/domain/types";
import { generateSchedule } from "../lib/domain/scheduler";
import { runExtractionPipeline } from "../lib/providers/extraction-pipeline";
import {
  TaskExtractionError,
  type TaskExtractionProvider,
} from "../lib/providers/task-extraction";
import { TEST_PREFERENCES } from "./fixtures";

const baseInput = {
  currentLocalDate: "2026-10-05",
  timeZone: "America/Los_Angeles",
};

const task = (
  patch: Partial<ExtractedTask> & Pick<ExtractedTask, "title" | "sourceText">,
): ExtractedTask => ({
  taskType: "flexible",
  priority: "medium",
  category: "other",
  energyDemand: "medium",
  splittable: false,
  confidence: 0.92,
  fieldConfidence: { title: 0.94, taskType: 0.91 },
  missingInformation: [],
  reviewRequired: false,
  approved: true,
  ...patch,
});

const result = (tasks: ExtractedTask[]): ExtractionResult => ({
  tasks,
  ignoredStatements: [],
});

function twelveWeekLearningPlan(firstDayLabel = "Day 1"): string {
  return [
    "12-Week Electronics Cooling Learning Plan",
    ...Array.from({ length: 12 }, (_, index) => {
      const week = index + 1;
      const label = week === 1 ? firstDayLabel : "Day 1";
      return `Week ${week} - Cooling topic ${week}\nDaily checklist:\n☐ ${label}: Complete cooling exercise ${week}.`;
    }),
  ].join("\n");
}

class FakeProvider implements TaskExtractionProvider {
  readonly extractTasks = vi.fn<(input: ExtractionInput) => Promise<ExtractionResult>>();

  constructor(
    response:
      | ExtractionResult
      | ((input: ExtractionInput) => ExtractionResult | Promise<ExtractionResult>),
  ) {
    this.extractTasks.mockImplementation(async (input) =>
      typeof response === "function" ? response(input) : response,
    );
  }
}

const failingSemanticProvider = () =>
  new FakeProvider(async () => {
    throw new Error("semantic provider unavailable");
  });

describe("AI-primary extraction pipeline", () => {
  it("always invokes the configured semantic provider for a simple day agenda", async () => {
    const input: ExtractionInput = {
      ...baseInput,
      text: [
        "Sunday",
        "8:15 AM — Inspect greenhouse irrigation",
        "9:40 AM — Inventory seed trays",
      ].join("\n"),
    };
    const semantic = new FakeProvider(
      result([
        task({
          id: "irrigation",
          title: "Inspect greenhouse irrigation",
          sourceText: "8:15 AM — Inspect greenhouse irrigation",
          taskType: "fixed_time",
          fixedStartAt: "2026-10-11T15:15:00.000Z",
          fixedEndAt: "2026-10-11T15:45:00.000Z",
        }),
        task({
          id: "seed-trays",
          title: "Inventory seed trays",
          sourceText: "9:40 AM — Inventory seed trays",
          taskType: "fixed_time",
          fixedStartAt: "2026-10-11T16:40:00.000Z",
          fixedEndAt: "2026-10-11T17:10:00.000Z",
        }),
      ]),
    );
    const local = new FakeProvider(result([]));

    const output = await runExtractionPipeline(input, {
      semanticProviderName: "gemini",
      semanticProvider: semantic,
      localProvider: local,
    });

    expect(semantic.extractTasks).toHaveBeenCalledOnce();
    expect(local.extractTasks).toHaveBeenCalledOnce();
    expect(output.extractionMode).toBe("gemini-hybrid");
    expect(output.report).toMatchObject({
      semanticProviderAttempted: true,
      semanticProviderUsed: true,
      localFallbackUsed: false,
    });
    expect(output.result.tasks.map(({ id }) => id)).toEqual([
      "irrigation",
      "seed-trays",
    ]);
  });

  it("never lets local disagreements rewrite successful AI identity, type, timing, count, or order", async () => {
    const certificateSource =
      "Please deliver the museum insurance certificate by Tuesday at 3 PM.";
    const walkthroughSource =
      "The conservators' walkthrough is Wednesday at 10 AM.";
    const input: ExtractionInput = {
      ...baseInput,
      text: `${certificateSource} ${walkthroughSource}`,
    };
    const semanticTasks = [
      task({
        id: "certificate",
        title: "Deliver museum insurance certificate",
        sourceText: certificateSource,
        taskType: "flexible",
        dueDate: "2026-10-06",
        dueTime: "15:00",
      }),
      task({
        id: "walkthrough",
        title: "Attend conservators' walkthrough",
        sourceText: walkthroughSource,
        taskType: "fixed_time",
        fixedStartAt: "2026-10-07T17:00:00.000Z",
        fixedEndAt: "2026-10-07T18:00:00.000Z",
      }),
    ];
    const localTasks = [
      task({
        title: "Conservators' walkthrough deadline",
        sourceText: walkthroughSource,
        taskType: "flexible",
        dueDate: "2026-10-08",
        dueTime: "16:30",
      }),
      task({
        title: "Museum certificate appointment",
        sourceText: certificateSource,
        taskType: "fixed_time",
        fixedStartAt: "2026-10-06T22:00:00.000Z",
        fixedEndAt: "2026-10-06T22:20:00.000Z",
      }),
      task({
        title: "Phone the archive",
        sourceText: certificateSource,
        taskType: "fixed_time",
        fixedStartAt: "2026-10-09T20:00:00.000Z",
        fixedEndAt: "2026-10-09T20:30:00.000Z",
      }),
    ];

    const output = await runExtractionPipeline(input, {
      semanticProviderName: "openai",
      semanticProvider: new FakeProvider(result(semanticTasks)),
      localProvider: new FakeProvider(result(localTasks)),
    });

    expect(output.extractionMode).toBe("openai-hybrid");
    expect(
      output.result.tasks.map((item) => ({
        id: item.id,
        title: item.title,
        taskType: item.taskType,
        dueDate: item.dueDate,
        dueTime: item.dueTime,
        fixedStartAt: item.fixedStartAt,
        fixedEndAt: item.fixedEndAt,
      })),
    ).toEqual(
      semanticTasks.map((item) => ({
        id: item.id,
        title: item.title,
        taskType: item.taskType,
        dueDate: item.dueDate,
        dueTime: item.dueTime,
        fixedStartAt: item.fixedStartAt,
        fixedEndAt: item.fixedEndAt,
      })),
    );
  });

  it("uses an explicit reviewed local fallback for complex prose after AI failure", async () => {
    const source =
      "Only after the resin samples finish curing, photograph each surface and then send the image set to the fabrication lab; if possible, keep the upload before dusk.";
    const input: ExtractionInput = { ...baseInput, text: source };
    const local = new FakeProvider(
      result([
        task({
          id: "resin-images",
          title: "Photograph cured resin surfaces",
          sourceText: source,
        }),
      ]),
    );

    const output = await runExtractionPipeline(input, {
      semanticProviderName: "gemini",
      semanticProvider: failingSemanticProvider(),
      localProvider: local,
    });

    expect(output.extractionMode).toBe("local-fallback");
    expect(output.report).toMatchObject({
      semanticProviderAttempted: true,
      semanticProviderUsed: false,
      localFallbackUsed: true,
    });
    expect(output.result.tasks.length).toBeGreaterThan(0);
    expect(output.result.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reviewRequired: true,
          approved: false,
          missingInformation: expect.arrayContaining([
            expect.stringMatching(/AI interpretation was unavailable/i),
          ]),
        }),
      ]),
    );
    expect(output.result.interpretation?.validationWarnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/local fallback/i)]),
    );
  });

  it("preserves the provider's specific fallback reason", async () => {
    const semantic = new FakeProvider(async () => {
      throw new TaskExtractionError(
        "INVALID_PROVIDER_OUTPUT",
        "The response reached its output limit.",
        { fallbackReason: "output_token_limit" },
      );
    });

    const output = await runExtractionPipeline(
      { ...baseInput, text: "Prepare the long learning plan." },
      {
        semanticProviderName: "gemini",
        semanticProvider: semantic,
        localProvider: new FakeProvider(result([])),
      },
    );

    expect(output.extractionMode).toBe("local-fallback");
    expect(output.report.fallbackReason).toBe("output_token_limit");
  });

  it("returns the AI failure instead of local tasks when fallback is disabled", async () => {
    const semantic = new FakeProvider(async () => {
      throw new TaskExtractionError(
        "INVALID_PROVIDER_OUTPUT",
        "The response reached its output limit.",
        { fallbackReason: "output_token_limit" },
      );
    });
    const local = new FakeProvider(
      result([
        task({
          id: "local-only",
          title: "Locally recovered task",
          sourceText: "Prepare the long learning plan.",
        }),
      ]),
    );

    await expect(
      runExtractionPipeline(
        { ...baseInput, text: "Prepare the long learning plan." },
        {
          semanticProviderName: "gemini",
          semanticProvider: semantic,
          localProvider: local,
          allowLocalFallback: false,
        },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_PROVIDER_OUTPUT",
      fallbackReason: "output_token_limit",
    });
  });

  it("keeps a simple exact agenda usable when the AI provider is unavailable", async () => {
    const agendaLine = "7:20 AM — Unlock the ceramics studio";
    const input: ExtractionInput = {
      ...baseInput,
      text: `Saturday\n${agendaLine}`,
    };
    const local = new FakeProvider(
      result([
        task({
          id: "unlock-studio",
          title: "Unlock ceramics studio",
          sourceText: agendaLine,
          taskType: "fixed_time",
          fixedStartAt: "2026-10-10T14:20:00.000Z",
          fixedEndAt: "2026-10-10T14:35:00.000Z",
        }),
      ]),
    );

    const output = await runExtractionPipeline(input, {
      semanticProviderName: "openai",
      semanticProvider: failingSemanticProvider(),
      localProvider: local,
    });

    expect(output.extractionMode).toBe("local-fallback");
    expect(output.result.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "unlock-studio",
          reviewRequired: false,
          approved: true,
        }),
      ]),
    );
    expect(
      output.result.tasks.flatMap((item) => item.missingInformation),
    ).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/AI interpretation was unavailable/i),
      ]),
    );
  });

  it("sends ordinary prose without parser-generated prompt hints", async () => {
    const source =
      "Revise the aviary map after the habitat survey, preferably Thursday afternoon for 35 minutes.";
    const input: ExtractionInput = {
      ...baseInput,
      text: source,
      structureHint:
        '{"segments":[{"role":"action"},{"role":"detail"}]}',
    };
    let semanticInput: ExtractionInput | undefined;
    const semantic = new FakeProvider((received) => {
      semanticInput = received;
      return result([
        task({
          id: "aviary-map",
          title: "Revise aviary map",
          sourceText: source,
          estimatedMinutes: 35,
          effortEstimateSource: "stated",
        }),
      ]);
    });

    await runExtractionPipeline(input, {
      semanticProviderName: "gemini",
      semanticProvider: semantic,
      localProvider: new FakeProvider(result([])),
    });

    expect(semanticInput?.text).toBe(source);
    expect(semanticInput?.structureHint).toBeUndefined();
  });

  it("recovers explicit recurring time ranges and exclusions after AI success", async () => {
    const source =
      "Exercise every day except Friday and Saturday from 6-8 PM starting today.";
    const semantic = new FakeProvider(
      result([
        task({
          id: "exercise",
          title: "Exercise",
          sourceText: source,
          taskType: "recurring_goal",
          estimatedMinutes: 120,
          effortEstimateSource: "stated",
          recurrence: {
            frequency: "daily",
            mode: "quota",
            interval: 1,
            anchorDate: "2026-09-04",
            count: 2,
            daysOfWeek: ["friday", "saturday"],
          },
        }),
      ]),
    );

    const output = await runExtractionPipeline(
      {
        currentLocalDate: "2026-09-04",
        timeZone: "America/Los_Angeles",
        text: source,
      },
      {
        semanticProviderName: "gemini",
        semanticProvider: semantic,
        localProvider: new FakeProvider(result([])),
      },
    );

    expect(output.extractionMode).toBe("gemini-hybrid");
    expect(output.result.tasks).toHaveLength(1);
    expect(output.result.tasks[0]).toMatchObject({
      id: "exercise",
      estimatedMinutes: 120,
      recurrence: {
        mode: "fixed_times",
        anchorDate: "2026-09-04",
        daysOfWeek: [
          "monday",
          "tuesday",
          "wednesday",
          "thursday",
          "sunday",
        ],
        timeRules: [
          {
            daysOfWeek: [
              "monday",
              "tuesday",
              "wednesday",
              "thursday",
              "sunday",
            ],
            time: "18:00",
          },
        ],
      },
    });

    const proposal = generateSchedule({
      windowStart: "2026-09-04T07:00:00.000Z",
      windowEnd: "2026-09-11T07:00:00.000Z",
      tasks: output.result.tasks,
      preferences: {
        ...TEST_PREFERENCES,
        timeZone: "America/Los_Angeles",
        wakingTime: "00:00",
        sleepingTime: "23:59",
      },
      availability: Array.from({ length: 7 }, (_, index) => ({
        start: `2026-09-${String(index + 5).padStart(2, "0")}T01:00:00.000Z`,
        end: `2026-09-${String(index + 5).padStart(2, "0")}T03:00:00.000Z`,
      })),
      unavailableEvents: [],
      blockedTimes: [],
      lockedSessions: [],
    });

    expect(proposal.sessions.map((session) => session.start)).toEqual([
      "2026-09-07T01:00:00.000Z",
      "2026-09-08T01:00:00.000Z",
      "2026-09-09T01:00:00.000Z",
      "2026-09-10T01:00:00.000Z",
      "2026-09-11T01:00:00.000Z",
    ]);
  });

  it("retains every Week/Day sequence after a successful semantic-provider extraction", async () => {
    const text = twelveWeekLearningPlan();
    const input: ExtractionInput = {
      currentLocalDate: "2026-08-31",
      timeZone: "America/Los_Angeles",
      text,
    };
    let semanticInput: ExtractionInput | undefined;
    const semantic = new FakeProvider((received) => {
      semanticInput = received;
      return result([
        task({
          id: "collapsed-learning-plan",
          title: "Complete the electronics cooling learning plan",
          sourceText: "12-Week Electronics Cooling Learning Plan",
          taskType: "recurring_goal",
        }),
      ]);
    });

    const output = await runExtractionPipeline(input, {
      semanticProviderName: "gemini",
      semanticProvider: semantic,
      localProvider: new FakeProvider(result([])),
    });

    expect(output.extractionMode).toBe("gemini-hybrid");
    expect(output.report.semanticProviderUsed).toBe(true);
    expect(semanticInput?.text).toBe(text);
    expect(semanticInput?.structureHint).toContain(
      "Structured 12-week learning plan with 12 checklist responsibilities.",
    );
    expect(semanticInput?.structureHint).toContain(
      "Week 12 — Cooling topic 12 | Day 1: Complete cooling exercise 12",
    );
    expect(output.result.tasks).toHaveLength(12);
    expect(output.result.tasks.map((item) => item.sequence?.week)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    expect(new Set(output.result.tasks.map((item) => item.sequence?.groupId))).toHaveLength(
      1,
    );
    expect(
      output.result.tasks.every(
        (item) =>
          item.sequence?.anchorDate === undefined &&
          item.reviewRequired &&
          !item.approved &&
          item.missingInformation.includes("Choose a plan start date"),
      ),
    ).toBe(true);
  });

  it.each(["local", "gemini"] as const)("keeps a plan starting next Tuesday flexible through the %s pipeline", async (provider) => {
    const text = `PLAN STARTS NEXT TUESDAY\n${twelveWeekLearningPlan()}`;
    const output = await runExtractionPipeline(
      { currentLocalDate: "2026-09-05", timeZone: "America/Los_Angeles", text },
      provider === "gemini"
        ? {
            semanticProviderName: "gemini",
            semanticProvider: new FakeProvider(result([
              task({ title: "Complete the learning plan", sourceText: text, taskType: "flexible" }),
            ])),
            localProvider: new FakeProvider(result([])),
          }
        : {},
    );
    expect(output.result.tasks).toHaveLength(12);
    expect(output.result.tasks.every((item) =>
      item.taskType === "flexible" &&
      item.sequence?.anchorDate === "2026-09-08" &&
      !item.dueDate && !item.recurrence &&
      item.approved && !item.reviewRequired &&
      item.missingInformation.length === 0,
    )).toBe(true);
  });

  it("anchors a successful semantic-provider plan to an explicit Week 1 Monday", async () => {
    const text = twelveWeekLearningPlan("This Monday");
    const rows = Array.from({ length: 12 }, (_, index) => {
      const week = index + 1;
      const sourceText = `☐ ${week === 1 ? "This Monday" : "Day 1"}: Complete cooling exercise ${week}.`;
      return task({
        id: `semantic-week-${week}`,
        title: `Complete cooling exercise ${week}`,
        sourceText,
        estimatedMinutes: 15 + week,
        effortEstimateSource: "ai",
      });
    });

    const output = await runExtractionPipeline(
      {
        currentLocalDate: "2026-08-31",
        timeZone: "America/Los_Angeles",
        sourceId: "successful-gemini-plan",
        text,
      },
      {
        semanticProviderName: "gemini",
        semanticProvider: new FakeProvider(result(rows)),
        localProvider: new FakeProvider(result([])),
      },
    );

    expect(output.extractionMode).toBe("gemini-hybrid");
    expect(output.result.tasks).toHaveLength(12);
    expect(
      output.result.tasks.every(
        (item) =>
          item.sequence?.anchorDate === "2026-08-31" &&
          item.approved &&
          !item.reviewRequired &&
          item.missingInformation.length === 0,
      ),
    ).toBe(true);
    expect(output.result.tasks[0]).toMatchObject({
      title: "Week 1, Day 1: Complete cooling exercise 1",
      estimatedMinutes: 16,
      sequence: {
        week: 1,
        day: 1,
        anchorDate: "2026-08-31",
      },
      sourceSpan: {
        sourceId: "successful-gemini-plan",
        quote: "☐ This Monday: Complete cooling exercise 1.",
      },
    });
    expect(output.result.tasks.at(-1)).toMatchObject({
      title: "Week 12, Day 1: Complete cooling exercise 12",
      estimatedMinutes: 27,
      sequence: {
        week: 12,
        day: 1,
        anchorDate: "2026-08-31",
      },
    });
  });
});
