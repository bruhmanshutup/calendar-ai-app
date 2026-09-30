import { describe, expect, it } from "vitest";
import type { ExtractionInput } from "../lib/domain/types";
import {
  analyzeNarrativeStructure,
  buildNarrativeStructureHint,
  prepareNarrativeStructureExtractionInput,
  prepareTaskExtractionInput,
} from "../lib/providers/narrative-structure";

const input = (text: string): ExtractionInput => ({
  text,
  currentLocalDate: "2026-08-12",
  timeZone: "America/Los_Angeles",
});

describe("narrative structure hints", () => {
  it("discovers each responsibility in deadline-and-meeting email prose", () => {
    const segments = analyzeNarrativeStructure(`Hi Zach,
Just a reminder that your design proposal is due Friday, September 4 at 11:59 PM. Before then, please send me your preliminary CAD drawings by Wednesday afternoon so I can review them.

We’ll meet Thursday at 2 PM for about an hour to go over feedback. If possible, try to make any final edits Thursday evening so you aren’t rushing Friday night.

Thanks!`);

    expect(segments.map((segment) => segment.role)).toEqual([
      "email_metadata",
      "action",
      "dependent_action",
      "action",
      "action",
      "email_metadata",
    ]);
    expect(
      segments.filter((segment) =>
        ["action", "dependent_action"].includes(segment.role),
      ),
    ).toHaveLength(4);
  });

  it("does not promote conditional or dependency context without an action", () => {
    const segments = analyzeNarrativeStructure(
      "If possible, Thursday evening would be best. Before then, the reviewer has the background notes.",
    );

    expect(segments.map((segment) => segment.role)).toEqual([
      "detail",
      "heading_or_context",
    ]);
  });

  it("keeps same-paragraph details with their action while finding dependent work", () => {
    const hint = buildNarrativeStructureHint(`This week is busy. I need to finish my physics problem set by Friday. It'll take around two hours. I'd rather split it into two sessions.

I have a project meeting Thursday at 6:30 PM. Before that, I should review our slides for 45 minutes.`);

    expect(hint).toContain(
      "P1: L1.S1=heading_or_context; L1.S2=action; L1.S3=detail; L1.S4=detail",
    );
    expect(hint).toContain(
      "P2: L1.S1=action; L1.S2=dependent_action",
    );
  });

  it("flags multiple independently schedulable actions inside one sentence", () => {
    const hint = buildNarrativeStructureHint(
      "I have a calculus quiz Monday morning, so I want to study for three hours beforehand.",
    );

    expect(hint).toContain("L1.S1=possible_multiple_actions");
  });

  it("separates global availability rules from a fixed social commitment", () => {
    const hint = buildNarrativeStructureHint(`Friday after 8 PM I want to keep completely free.

Saturday I'm hanging out with friends from 5 PM until late, so don't schedule anything then.

I usually wake up at 8 AM and go to sleep around midnight.`);

    expect(hint).toContain("P1: L1.S1=global_schedule_rule");
    expect(hint).toContain("P2: L1.S1=action");
    expect(hint).toContain("P3: L1.S1=global_schedule_rule");
  });

  it("understands common casual action and continuation wording", () => {
    const hint = buildNarrativeStructureHint(`Gotta renew my library card. It should only take ten minutes. No real deadline.

I'm supposed to book a checkup. They're only open from 9 AM to 5 PM. If possible, do it Thursday.

Don't forget to pay the electricity bill.

Could you remind me to call Grandma?`);

    expect(hint).toContain(
      "P1: L1.S1=action; L1.S2=detail; L1.S3=detail",
    );
    expect(hint).toContain(
      "P2: L1.S1=action; L1.S2=detail; L1.S3=detail",
    );
    expect(hint).toContain("P3: L1.S1=action");
    expect(hint).toContain("P4: L1.S1=action");
  });

  it("distinguishes email scaffolding, actionable prose, and checklist state", () => {
    const hint = buildNarrativeStructureHint(`From: manager@example.com
To: me@example.com
Subject: Please review the launch draft
Hi Maya,
Please review the launch draft by Thursday.
It should take about 30 minutes.
- Call the printer about proofs
[x] Pay the deposit
Thanks,`);

    expect(hint).toContain("L1.S1=email_metadata");
    expect(hint).toContain("L2.S1=email_metadata");
    expect(hint).toContain("L3.S1=email_subject");
    expect(hint).toContain("L4.S1=email_metadata");
    expect(hint).toContain("L5.S1=action");
    expect(hint).toContain("L6.S1=detail");
    expect(hint).toContain("L7.S1=action");
    expect(hint).toContain("L8.S1=completed_item");
    expect(hint).toContain("L9.S1=email_metadata");
  });

  it("does not split common abbreviations into fake sentence boundaries", () => {
    const hint = buildNarrativeStructureHint(
      "Email Dr. Lee about the lab. It should take 15 minutes.",
    );

    expect(hint).toContain("L1.S1=action; L1.S2=detail");
    expect(hint).not.toContain("L1.S3=");
  });

  it("keeps the original source untouched and caps hints for very large input", () => {
    const text = Array.from(
      { length: 300 },
      (_, index) => `I need to complete item ${index + 1}. It takes ten minutes.`,
    ).join("\n\n");
    const prepared = prepareNarrativeStructureExtractionInput(input(text));

    expect(prepared.text).toBe(text);
    expect(prepared.structureHint?.length).toBeLessThanOrEqual(8_030);
    expect(prepared.structureHint).toContain(
      "Additional segments omitted after the first 180.",
    );
  });

  it("leaves specialized Week/Day plan preparation in control", () => {
    const prepared = prepareTaskExtractionInput(
      input(`12-Week Learning Plan
Week 1 - Basics
Daily checklist:
Day 1: Read chapter one
Day 2: Complete practice problems
Week 2 - Applications
Daily checklist:
Day 1: Build a small model
Day 2: Review the results`),
    );

    expect(prepared.text).toContain("12-Week Learning Plan");
    expect(prepared.structureHint).toContain(
      "Structured 2-week learning plan with 4 checklist responsibilities.",
    );
    expect(prepared.structureHint).toContain(
      "Week 2 — Applications | Day 2: Review the results",
    );
  });
});
