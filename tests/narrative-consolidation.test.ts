import { describe, expect, it } from "vitest";
import type { ExtractionInput, ExtractionResult } from "../lib/domain/types";
import { consolidateNarrativeExtraction } from "../lib/providers/narrative-consolidation";
import { task } from "./fixtures";

function consolidate(text: string, tasks: ExtractionResult["tasks"]) {
  const input: ExtractionInput = {
    text,
    currentLocalDate: "2026-08-12",
    timeZone: "America/Los_Angeles",
  };
  return consolidateNarrativeExtraction(input, {
    tasks,
    ignoredStatements: [],
  });
}

describe("narrative task consolidation", () => {
  it("merges duplicate action cards and continuation-only review cards", () => {
    const lab =
      "I need to finish the biology lab report by Friday. It'll take about two hours, and I want it split into two sessions.";
    const email =
      "Email my academic adviser about changing sections. This is important and needs to be done by Thursday. It should take 15 minutes.";
    const free = "Friday after 8 PM I want to keep completely free.";
    const result = consolidate(`${lab}\n\n${email}\n\n${free}`, [
      task({ id: "lab-good", title: "Finish biology lab report", sourceText: lab, estimatedMinutes: 120, effortEstimateSource: "stated" }),
      task({ id: "lab-duplicate", title: "I need to finish the biology lab report", sourceText: "I need to finish the biology lab report by Friday.", approved: false, reviewRequired: true, missingInformation: ["Confirm effort estimate"] }),
      task({ id: "email-good", title: "Email academic adviser about changing sections", sourceText: "Email my academic adviser about changing sections.", estimatedMinutes: 15 }),
      task({ id: "important-fragment", title: "This is important and needs to be done", sourceText: "This is important and needs to be done by Thursday.", approved: false, reviewRequired: true, missingInformation: ["Confirm effort estimate"] }),
      task({ id: "free-fragment", title: "Friday after 8 PM keep completely free", sourceText: free, approved: false, reviewRequired: true }),
    ]);

    expect(result.tasks).toHaveLength(2);
    expect(result.tasks.map((item) => item.title)).toEqual([
      "Finish biology lab report",
      "Email academic adviser about changing sections",
    ]);
    expect(result.tasks[0].sourceText).toContain("split into two sessions");
    expect(result.tasks[1].sourceText).toContain("It should take 15 minutes");
    expect(result.ignoredStatements.some((item) => item.sourceText === free)).toBe(true);
  });

  it("keeps an event, its preparation, and two actions in one sentence distinct", () => {
    const interview =
      "I have an internship interview Thursday at 2 PM. Before that, I should spend 40 minutes reviewing the company notes.";
    const quiz =
      "I have a chemistry quiz Monday morning, so I want to study for three hours beforehand. Break that into shorter sessions.";
    const result = consolidate(`${interview}\n\n${quiz}`, [
      task({ id: "interview", title: "Internship interview", sourceText: "I have an internship interview Thursday at 2 PM.", taskType: "fixed_time" }),
      task({ id: "prep", title: "Review company notes", sourceText: "Before that, I should spend 40 minutes reviewing the company notes.", estimatedMinutes: 40 }),
      task({ id: "quiz", title: "Chemistry quiz", sourceText: quiz.split(".")[0], taskType: "fixed_time" }),
      task({ id: "study", title: "Study for chemistry quiz", sourceText: quiz.split(".")[0], estimatedMinutes: 180 }),
      task({ id: "split-fragment", title: "Break that into shorter sessions", sourceText: "Break that into shorter sessions.", approved: false, reviewRequired: true }),
    ]);

    expect(result.tasks).toHaveLength(4);
    expect(result.tasks.map((item) => item.title)).toEqual([
      "Internship interview",
      "Review company notes",
      "Chemistry quiz",
      "Study for chemistry quiz",
    ]);
    expect(result.tasks.find((item) => item.id === "study")?.sourceText).toContain(
      "Break that into shorter sessions",
    );
  });

  it("preserves wrapped email and checklist details without combining separate rows", () => {
    const text = `From: building@example.com
Subject: Apartment errands for this week
Hi,
- Order the prescription refill
The pharmacy closes at 6 PM, and it should take ten minutes.
- Buy a replacement air filter
The required size is 16x20x1, and it is needed before Sunday afternoon.
- Wash the guest sheets
This can wait until the weekend.
Thanks,`;
    const result = consolidate(text, [
      task({ id: "refill", title: "Order prescription refill", sourceText: "- Order the prescription refill", estimatedMinutes: 10, minimumSessionMinutes: 10 }),
      task({ id: "filter", title: "Buy replacement air filter", sourceText: "- Buy a replacement air filter" }),
      task({ id: "sheets", title: "Wash guest sheets", sourceText: "- Wash the guest sheets" }),
    ]);

    expect(result.tasks).toHaveLength(3);
    expect(result.tasks[0].sourceText).toContain("pharmacy closes at 6 PM");
    expect(result.tasks[1].sourceText).toContain("16x20x1");
    expect(result.tasks[2].sourceText).toContain("wait until the weekend");
    expect(result.tasks[0].sourceText).not.toContain("replacement air filter");
  });

  it("deduplicates an actionable email subject when the body repeats it", () => {
    const text = `From: project@example.com
Subject: Please review the launch draft
Hi,
Please review the launch draft by Thursday afternoon. It should take about 30 minutes.
Thanks,`;
    const result = consolidate(text, [
      task({
        id: "subject-copy",
        title: "Review launch draft",
        sourceText: "Subject: Please review the launch draft",
        approved: false,
        reviewRequired: true,
      }),
      task({
        id: "body-copy",
        title: "Review the launch draft",
        sourceText: "Please review the launch draft by Thursday afternoon.",
        estimatedMinutes: 30,
        effortEstimateSource: "stated",
      }),
    ]);

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      title: "Review the launch draft",
      estimatedMinutes: 30,
      reviewRequired: false,
    });
    expect(result.tasks[0].sourceText).toContain("It should take about 30 minutes");
  });
});
