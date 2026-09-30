import { describe, expect, it } from "vitest";
import { annotateImportEvidence, userDeadlineClockEvidence } from "../lib/providers/import-instruction-evidence";
import { reconcileHybridExtraction } from "../lib/providers/hybrid-reconciliation";
import { scheduling, task } from "./fixtures";
import { extractedTaskSchema } from "../lib/domain/extraction-schema";
import { generateSchedule } from "../lib/domain/scheduler";

const base = { currentLocalDate: "2026-09-21", timeZone: "America/Chicago",
  text: "| Day | Date | Agenda | Due |\n| Tue | 09/06 | Lecture | Read chapter |",
  globalInstructions: "Ignore the agenda and make the deadline at 7 in the morning on that day.",
};
const reading = () => task({title: "Read chapter", sourceText: "Read chapter", dueDate: "2022-09-06", dueTime: "07:00", dueAt: "2022-09-06T12:00:00Z"});

describe("user deadline evidence and yearless calendars", () => {
  it("labels the user clock, retains MM/DD for review, and removes the invented year", () => {
    const result = annotateImportEvidence(base, reading());
    expect(result.dueDate).toBeUndefined(); expect(result.dueAt).toBeUndefined();
    expect(result.dueTime).toBe("07:00");
    expect(result.reviewRequired).toBe(true); expect(result.approved).toBe(false);
    expect(result.missingInformation.join(" ")).toContain("Confirm the year for 09/06");
    expect(result.fieldProvenance?.find(f => f.path === "dueTime")?.origin).toBe("user");
    expect(extractedTaskSchema.safeParse(result).success).toBe(true);
  });
  it("allows an unresolved clock only with a review blocker and no fabricated instant", () => {
    const unresolved = { ...reading(), dueDate: undefined, dueAt: undefined, reviewRequired: true, missingInformation: ["Confirm the year for 09/06."] };
    expect(extractedTaskSchema.safeParse(unresolved).success).toBe(true);
    expect(extractedTaskSchema.safeParse({ ...unresolved, reviewRequired: false }).success).toBe(false);
    expect(extractedTaskSchema.safeParse({ ...unresolved, missingInformation: [] }).success).toBe(false);
    expect(extractedTaskSchema.safeParse({ ...unresolved, dueAt: reading().dueAt }).success).toBe(false);
    expect(generateSchedule(scheduling([unresolved])).sessions).toHaveLength(0);
  });
  it.each(["7 AM", "7 in the morning", "07:00", "7 a.m."])("accepts a supplied clock written as %s", (clock) => {
    expect(userDeadlineClockEvidence({...base, globalInstructions: `Set deadlines at ${clock}.`}, reading())).toBeDefined();
  });
  it("does not attribute a different clock to the user", () => {
    expect(userDeadlineClockEvidence({...base, globalInstructions: "Set deadlines at 8 AM."}, reading())).toBeUndefined();
  });
  it("does not flag the user-supplied clock as absent from source evidence", () => {
    const output = reconcileHybridExtraction(base, { tasks:[reading()], ignoredStatements:[] }, { tasks:[], ignoredStatements:[] });
    expect(output.diagnostics.taskDiagnostics[0].issues).not.toContainEqual(expect.objectContaining({code:"unsupported_exact_time"}));
  });
  it("still flags an unsupported clock with no user instruction", () => {
    const output = reconcileHybridExtraction({...base, globalInstructions:undefined}, { tasks:[reading()], ignoredStatements:[] }, { tasks:[], ignoredStatements:[] });
    expect(output.diagnostics.taskDiagnostics[0].issues).toContainEqual(expect.objectContaining({code:"unsupported_exact_time"}));
  });
  it("preserves dates when the year is supplied in the source or user instructions", () => {
    expect(annotateImportEvidence({...base, text: `Fall 2022\n${base.text}`}, reading()).dueDate).toBe("2022-09-06");
    expect(annotateImportEvidence({...base, globalInstructions:`${base.globalInstructions} Use 2026.`}, {...reading(), dueDate:"2026-09-06"}).dueDate).toBe("2026-09-06");
  });
  it("does not change ordinary relative-date tasks", () => {
    expect(annotateImportEvidence({...base, text:"Read chapter tomorrow."}, reading()).dueDate).toBe("2022-09-06");
  });
});
