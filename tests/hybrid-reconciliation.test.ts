import { describe, expect, it } from "vitest";
import type {
  ExtractedTask,
  ExtractionInput,
  ExtractionResult,
} from "../lib/domain/types";
import { reconcileHybridExtraction } from "../lib/providers/hybrid-reconciliation";

const input = (text: string): ExtractionInput => ({
  text,
  currentLocalDate: "2026-10-05",
  timeZone: "America/Los_Angeles",
});

const task = (
  patch: Partial<ExtractedTask> & Pick<ExtractedTask, "title" | "sourceText">,
): ExtractedTask => ({
  taskType: "flexible",
  priority: "medium",
  category: "other",
  energyDemand: "medium",
  splittable: false,
  confidence: 0.9,
  fieldConfidence: { title: 0.9, taskType: 0.9 },
  missingInformation: [],
  reviewRequired: false,
  approved: true,
  ...patch,
});

const result = (tasks: ExtractedTask[]): ExtractionResult => ({
  tasks,
  ignoredStatements: [],
});

describe("hybrid extraction reconciliation", () => {
  it("does not let a locally misattached meeting time contaminate separate semantic tasks", () => {
    const text = "Finish the actuator sketch by Thursday. The design team will meet Friday at 4 PM.";
    const semantic = result([
      task({
        id: "sketch",
        title: "Finish actuator sketch",
        sourceText: "Finish the actuator sketch by Thursday.",
        dueDate: "2026-10-08",
      }),
      task({
        id: "meeting",
        title: "Design team meeting",
        sourceText: "The design team will meet Friday at 4 PM.",
        taskType: "fixed_time",
        fixedStartAt: "2026-10-09T23:00:00.000Z",
        fixedEndAt: "2026-10-10T00:00:00.000Z",
      }),
    ]);
    const local = result([
      task({
        title: "Finish actuator sketch",
        sourceText: text,
        taskType: "fixed_time",
        fixedStartAt: "2026-10-09T23:00:00.000Z",
        fixedEndAt: "2026-10-10T00:00:00.000Z",
      }),
    ]);

    const reconciled = reconcileHybridExtraction(input(text), semantic, local, "gemini");

    expect(reconciled.result.tasks).toEqual(semantic.tasks);
    expect(reconciled.result.tasks.map((item) => item.id)).toEqual(["sketch", "meeting"]);
    expect(reconciled.diagnostics.ignoredLocalTaskCount).toBe(1);
    expect(reconciled.diagnostics.taskDiagnostics.every((item) => item.status === "local_ambiguous")).toBe(true);
  });

  it("ignores a local task that merged two independent actions", () => {
    const text = "Calibrate the thermistor. Photograph the enclosure label.";
    const semantic = result([
      task({ title: "Calibrate thermistor", sourceText: "Calibrate the thermistor." }),
      task({ title: "Photograph enclosure label", sourceText: "Photograph the enclosure label." }),
    ]);
    const local = result([
      task({ title: "Calibrate and photograph", sourceText: text, estimatedMinutes: 45 }),
    ]);

    const reconciled = reconcileHybridExtraction(input(text), semantic, local);

    expect(reconciled.result.tasks).toEqual(semantic.tasks);
    expect(reconciled.diagnostics.ignoredLocalTaskCount).toBe(1);
    expect(reconciled.diagnostics.reviewFlagCount).toBe(0);
  });

  it("records agreement without changing semantic task fields or provenance", () => {
    const text = "Submit the vibration memo by Tuesday at 11:30 AM.";
    const provenance = [{ path: "dueTime", origin: "explicit" as const }];
    const semanticTask = task({
      title: "Submit vibration memo",
      sourceText: text,
      dueDate: "2026-10-06",
      dueTime: "11:30",
      fieldProvenance: provenance,
    });
    const localTask = task({
      title: "Vibration memo",
      sourceText: text,
      dueDate: "2026-10-06",
      dueTime: "11:30",
    });

    const reconciled = reconcileHybridExtraction(input(text), result([semanticTask]), result([localTask]));

    expect(reconciled.result.tasks[0]).toEqual(semanticTask);
    expect(reconciled.result.tasks[0].fieldProvenance).toBe(provenance);
    expect(reconciled.diagnostics.agreementCount).toBe(1);
  });

  it("ignores estimate, category, priority, and energy disagreements", () => {
    const text = "Outline the materials section before Wednesday.";
    const semanticTask = task({
      title: "Outline materials section",
      sourceText: text,
      dueDate: "2026-10-07",
      estimatedMinutes: 80,
      category: "school",
      priority: "high",
      energyDemand: "high",
    });
    const localTask = task({
      title: "Outline materials section",
      sourceText: text,
      dueDate: "2026-10-07",
      estimatedMinutes: 25,
      category: "work",
      priority: "low",
      energyDemand: "low",
    });

    const reconciled = reconcileHybridExtraction(input(text), result([semanticTask]), result([localTask]));

    expect(reconciled.result.tasks[0]).toEqual(semanticTask);
    expect(reconciled.diagnostics.reviewFlagCount).toBe(0);
    expect(reconciled.diagnostics.agreementCount).toBe(1);
  });

  it("flags an unsupported exact time invented by the semantic model", () => {
    const text = "Review the supplier quote sometime next week.";
    const semanticTask = task({
      title: "Review supplier quote",
      sourceText: text,
      taskType: "fixed_time",
      fixedStartAt: "2026-10-13T17:00:00.000Z",
      fixedEndAt: "2026-10-13T17:30:00.000Z",
      fieldProvenance: [{ path: "fixedStartAt", origin: "inferred" }],
    });

    const reconciled = reconcileHybridExtraction(input(text), result([semanticTask]), result([]), "gemini");
    const reviewed = reconciled.result.tasks[0];

    expect(reviewed.taskType).toBe("fixed_time");
    expect(reviewed.fixedStartAt).toBe(semanticTask.fixedStartAt);
    expect(reviewed.title).toBe(semanticTask.title);
    expect(reviewed.fieldProvenance).toEqual(semanticTask.fieldProvenance);
    expect(reviewed.reviewRequired).toBe(true);
    expect(reviewed.approved).toBe(false);
    expect(reviewed.missingInformation).toContain(
      "Confirm the exact time; it does not appear in the source text.",
    );
    expect(reconciled.diagnostics.taskDiagnostics[0].issues[0].code).toBe(
      "unsupported_exact_time",
    );
  });

  it("flags a supported deadline-versus-event disagreement without overwriting AI semantics", () => {
    const text = "The safety inspection is due Friday at 3 PM.";
    const semanticTask = task({
      title: "Safety inspection",
      sourceText: text,
      taskType: "fixed_time",
      fixedStartAt: "2026-10-09T22:00:00.000Z",
      fixedEndAt: "2026-10-09T22:30:00.000Z",
    });
    const localTask = task({
      title: "Complete safety inspection",
      sourceText: text,
      dueDate: "2026-10-09",
      dueTime: "15:00",
    });

    const reconciled = reconcileHybridExtraction(input(text), result([semanticTask]), result([localTask]));

    expect(reconciled.result.tasks[0].taskType).toBe("fixed_time");
    expect(reconciled.result.tasks[0].fixedStartAt).toBe(semanticTask.fixedStartAt);
    expect(reconciled.result.tasks[0].reviewRequired).toBe(true);
    expect(reconciled.result.tasks[0].missingInformation).toContain(
      "Confirm whether this is a deadline or a scheduled event.",
    );
  });

  it("preserves semantic planning rules, ignored statements, task order, and interpretation metadata", () => {
    const text = "Draft the abstract. The lab is closed Sunday.";
    const semantic: ExtractionResult = {
      tasks: [
        task({ id: "draft", title: "Draft abstract", sourceText: "Draft the abstract." }),
      ],
      ignoredStatements: [
        { sourceText: "The lab is closed Sunday.", reason: "Availability context." },
      ],
      planningRules: { latestWorkTime: "20:00" },
      interpretation: {
        discoveredResponsibilityCount: 1,
        explicitFieldCount: 1,
        derivedFieldCount: 0,
        inferredFieldCount: 0,
        globalInstructions: [],
        validationWarnings: ["Existing warning"],
      },
    };

    const reconciled = reconcileHybridExtraction(input(text), semantic, result([]));

    expect(reconciled.result.tasks.map((item) => item.id)).toEqual(["draft"]);
    expect(reconciled.result.ignoredStatements).toBe(semantic.ignoredStatements);
    expect(reconciled.result.planningRules).toBe(semantic.planningRules);
    expect(reconciled.result.interpretation).toEqual(semantic.interpretation);
  });
});
