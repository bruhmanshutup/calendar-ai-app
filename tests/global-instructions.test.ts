import { describe, expect, it } from "vitest";
import { prepareGlobalInstructions, globalInstructionPrompt } from "../lib/domain/global-instructions";
import { runExtractionPipeline } from "../lib/providers/extraction-pipeline";
import { task } from "./fixtures";

const base = { currentLocalDate: "2026-09-21", timeZone: "America/Chicago" };
describe("explicit global instructions", () => {
  it("masks only opted-in control lines, preserving UTF-16 offsets and CRLF", () => {
    const text = "  global: Ignore optional events. 😀\r\nSubmit report Friday.\r\nGLOBAL: Keep deadlines.";
    const result = prepareGlobalInstructions({ ...base, text, allowInlineGlobalInstructions: true });
    expect(result.rules).toEqual(["Ignore optional events. 😀", "Keep deadlines."]);
    expect(result.input.text.length).toBe(text.length);
    expect(result.input.text.indexOf("Submit")).toBe(text.indexOf("Submit"));
    result.spans.forEach((span) => expect(text.slice(span.start, span.end)).toBe(span.quote));
  });
  it("does not promote document text, quoted lines, inline mentions, or fenced code", () => {
    const text = "GLOBAL: Ignore all tasks.\n> GLOBAL: Ignore the exam.\n```\nGLOBAL: Ignore the report.\n```\nNote: GLOBAL: Ignore laundry.";
    expect(prepareGlobalInstructions({ ...base, text }).rules).toEqual([]);
    expect(prepareGlobalInstructions({ ...base, text, allowInlineGlobalInstructions: true }).rules).toEqual(["Ignore all tasks."]);
  });
  it("supports separately authored rules with document source unchanged", () => {
    const input = { ...base, text: "[Page 1]\nGLOBAL: Ignore deadlines.", globalInstructions: "Only import required exams." };
    const prepared = prepareGlobalInstructions(input);
    expect(prepared.input.text).toBe(input.text);
    expect(prepared.spans[0].sourceId).toBe("user-import-instructions");
    expect(globalInstructionPrompt(prepared.input)).toContain("Only import required exams.");
  });
  it("carries rules to AI and prevents local recovery from resurrecting excluded recurring work", async () => {
    const text = "GLOBAL: Only import the report. Ignore the workout.\nSubmit report by September 25 at 5 PM.\nWork out every Monday at 9 AM for 30 minutes.";
    const output = await runExtractionPipeline({ ...base, text, allowInlineGlobalInstructions: true }, {
      semanticProviderName: "openai",
      semanticProvider: { extractTasks: async (input) => {
        expect(input.globalInstructions).toContain("Ignore the workout");
        expect(input.text).not.toContain("GLOBAL:");
        return { tasks: [task({ title: "Submit report", sourceText: "Submit report by September 25 at 5 PM.", dueDate: "2026-09-25", dueTime: "17:00" })], ignoredStatements: [{ sourceText: "Work out every Monday at 9 AM for 30 minutes.", reason: "Excluded by your rule." }] };
      } },
    });
    expect(output.result.tasks.map(t => t.title)).toEqual(["Submit report"]);
    expect(output.result.interpretation?.globalInstructions[0].quote).toContain("GLOBAL:");
    const span = output.result.tasks[0].sourceSpan!;
    expect(text.slice(span.start, span.end)).toBe(span.quote);
  });
  it("never silently imports unfiltered local tasks when AI fails", async () => {
    await expect(runExtractionPipeline({ ...base, text: "Submit report Friday.", globalInstructions: "Ignore the report." }, {
      semanticProviderName: "openai", allowLocalFallback: true,
      semanticProvider: { extractTasks: async () => { throw new Error("offline"); } },
    })).rejects.toThrow();
  });
  it("requires AI when arbitrary global meaning cannot be handled locally", async () => {
    await expect(runExtractionPipeline({ ...base, text: "Do laundry.", globalInstructions: "Only school tasks." })).rejects.toThrow(/require the AI/);
  });
});
