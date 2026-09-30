import { describe, expect, it } from "vitest";
import { formatInTimeZone } from "date-fns-tz";
import { compileSemanticDraft } from "../lib/providers/semantic-draft-compiler";
import { semanticDraftSchema, type SemanticDraft } from "../lib/providers/semantic-draft";
import { normalizeSemanticDraftProviderOutput } from "../lib/providers/semantic-draft-provider-normalization";
import { validateAndDedupeExtraction } from "../lib/domain/extraction-schema";
import { applyLinkedTaskEdit, arrivalBufferReservations } from "../lib/domain/linked-timing";
import { mergeImportedTasks } from "../lib/domain/task-import";
import { runExtractionPipeline } from "../lib/providers/extraction-pipeline";

const context = { currentLocalDate: "2026-09-05", timeZone: "America/Los_Angeles" };
const clock = (value?: string) => value ? formatInTimeZone(value, context.timeZone, "yyyy-MM-dd HH:mm") : undefined;

function fixture(subject = "flight", destination = "airport") {
  const text = `actually ariving at ${destination} takes 30 minutes, i need to catch a 3 hour ${subject} at 6 pm on september 10 adn want to arrive 2 hours early`;
  const common = { confidence: 1, reviewRequired: false, missingInformation: [] };
  const draft: SemanticDraft = {
    responsibilities: [
      { ...common, id: "main", title: `3 hour ${subject}`, kind: "event", sourceText: `i need to catch a 3 hour ${subject} at 6 pm on september 10`, occurrence: { date: "2026-09-10", dateSourceText: "september 10", startTime: "18:00", endTime: "21:00", confidence: 1 }, duration: { preferredMinutes: 180, explicit: true } },
      { ...common, id: "arrival", title: "Early arrival", kind: "milestone", sourceText: "want to arrive 2 hours early" },
      { ...common, id: "travel", title: `Travel to ${destination}`, kind: "task", sourceText: `actually ariving at ${destination} takes 30 minutes`, duration: { preferredMinutes: 30, explicit: true } },
    ],
    relations: [
      { fromId: "arrival", toId: "main", relation: "before", strength: "hard", timing: "arrival_buffer", fromBoundary: "start", toBoundary: "start", minimumGapMinutes: 120, mode: "exact", reason: "AI-interpreted early arrival." },
      { fromId: "travel", toId: "arrival", relation: "before", strength: "hard", timing: "travel", fromBoundary: "end", toBoundary: "start", minimumGapMinutes: 0, mode: "exact", reason: "AI-interpreted journey ending at arrival." },
    ],
    blockedTimes: [], globalInstructions: [], ignoredStatements: [],
  };
  return { text, draft };
}
function compile(test = fixture()) {
  return validateAndDedupeExtraction(compileSemanticDraft({ ...context, text: test.text }, semanticDraftSchema.parse(test.draft)));
}

describe("independent calculator-only special timing", () => {
  it.each([["flight", "airport"], ["workshop", "studio"], ["concert", "theater"]])("uses the same arithmetic for %s, with no source checks", (subject, destination) => {
    const tasks = compile(fixture(subject, destination)).tasks;
    expect(clock(tasks[0].fixedStartAt)).toBe("2026-09-10 18:00");
    expect(clock(tasks[0].fixedEndAt)).toBe("2026-09-10 21:00");
    expect(tasks[0].estimatedMinutes).toBe(180);
    expect(tasks[0].reviewRequired).toBe(false);
    expect(clock(tasks[1].fixedStartAt)).toBe("2026-09-10 16:00");
    expect(clock(tasks[2].fixedStartAt)).toBe("2026-09-10 15:30");
    expect(clock(tasks[2].fixedEndAt)).toBe("2026-09-10 16:00");
    for (const task of tasks.slice(1)) {
      expect(task.schedulingConstraints?.calculatedTiming).toBeDefined();
      expect(task.schedulingConstraints?.linkedTiming).toBeUndefined();
      expect(task.dependencies).toBeUndefined();
      expect(task.sequence).toBeUndefined();
      expect(task.reviewRequired).toBe(true);
    }
  });

  it("accepts a mismatched responsibility quote and nonzero travel gap without correcting the AI", () => {
    const test = fixture();
    test.draft.responsibilities[2].sourceText = "AI paraphrase that does not exist in the source.";
    test.draft.relations[1].sourceText = "Another paraphrase.";
    test.draft.relations[1].minimumGapMinutes = 30;
    const travel = compile(test).tasks[2];
    // Deliberately incorrect AI interpretation: calculator follows it, no hidden repair.
    expect(clock(travel.fixedStartAt)).toBe("2026-09-10 15:00");
    expect(clock(travel.fixedEndAt)).toBe("2026-09-10 15:30");
    expect(travel.missingInformation.join(" ")).not.toContain("Cannot calculate the relationship");
  });

  it("does not reject a special relationship due to recurrence metadata", () => {
    const test = fixture();
    test.draft.responsibilities[2].recurrence = { frequency: "weekly" };
    expect(clock(compile(test).tasks[2].fixedStartAt)).toBe("2026-09-10 15:30");
  });

  it("does not feed unused calculated dates through main-event validation", () => {
    const test = fixture();
    test.draft.responsibilities[2].occurrence = { date: "", confidence: 1 };
    const normalized = normalizeSemanticDraftProviderOutput(test.draft);
    expect(semanticDraftSchema.safeParse(normalized).success).toBe(true);
    test.draft.responsibilities[0].occurrence!.date = "2026-02-31";
    expect(semanticDraftSchema.safeParse(normalizeSemanticDraftProviderOutput(test.draft)).success).toBe(false);
  });

  it("still validates main-event evidence while retaining calculable proposals", () => {
    const test = fixture();
    test.draft.responsibilities[0].occurrence!.dateSourceText = "invented date quote";
    const tasks = compile(test).tasks;
    expect(tasks[0].missingInformation.join(" ")).toContain("date is provisional");
    expect(clock(tasks[2].fixedStartAt)).toBe("2026-09-10 15:30");
  });

  it("does not recalculate snapshots when the main event is edited or removed", () => {
    const tasks = compile().tasks;
    const updated = applyLinkedTaskEdit(tasks, "main", { fixedStartAt: "2026-09-12T03:00:00Z" }, context.timeZone);
    expect(updated[1]).toEqual(tasks[1]);
    expect(updated[2]).toEqual(tasks[2]);
    expect(arrivalBufferReservations(updated, true)).toEqual([]);
    expect(updated[1]).toMatchObject({ fixedStartAt: "2026-09-10T23:00:00.000Z", fixedEndAt: "2026-09-11T01:00:00.000Z" });
    const merged = mergeImportedTasks([], tasks).tasks;
    expect(merged.every((task) => !task.schedulingConstraints?.linkedTiming && !task.dependencies?.length)).toBe(true);
  });

  it("upgrades old linked cards on reimport without preserving their links", () => {
    const fresh = compile().tasks;
    const old = structuredClone(fresh);
    delete old[2].schedulingConstraints!.calculatedTiming;
    old[2].schedulingConstraints!.linkedTiming = { rules: [{ taskId: "arrival", boundary: "end", targetBoundary: "start", offsetMinutes: 0, mode: "exact", approximate: false }], approximate: false, durationEstimated: false, arrivalBuffer: false };
    old[2].dependencies = [{ taskId: "arrival", relation: "before" }];
    const result = mergeImportedTasks(old, fresh);
    expect(result.tasks).toHaveLength(3);
    expect(result.tasks[2].schedulingConstraints?.calculatedTiming).toBeDefined();
    expect(result.tasks[2].schedulingConstraints?.linkedTiming).toBeUndefined();
    expect(result.tasks[2].dependencies).toBeUndefined();
  });

  it("bypasses later reconciliation and recovery in the production pipeline", async () => {
    const test = fixture();
    test.draft.responsibilities[2].sourceText = "A nonliteral AI description.";
    const semantic = compile(test);
    const result = await runExtractionPipeline({ ...context, text: test.text }, {
      semanticProviderName: "gemini", allowLocalFallback: false,
      semanticProvider: { extractTasks: async () => semantic },
      localProvider: { extractTasks: async () => ({ tasks: [], ignoredStatements: [] }) },
    });
    const restored = validateAndDedupeExtraction(JSON.parse(JSON.stringify(result.result)));
    expect(restored.tasks.find((task) => task.id === "travel")).toEqual({
      ...JSON.parse(JSON.stringify(semantic.tasks[2])),
      classification: { kind: "task", timing: "fixed_time", recurrence: "once" },
    });
    expect(result.report.localFallbackUsed).toBe(false);
  });
});
