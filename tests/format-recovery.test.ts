import { describe, expect, it } from "vitest";
import type { ExtractionInput, ExtractionResult } from "../lib/domain/types";
import { recoverConcreteFormattedTasks } from "../lib/providers/format-recovery";
import { task } from "./fixtures";

const input = (text: string): ExtractionInput => ({
  text,
  currentLocalDate: "2026-08-12",
  timeZone: "America/Los_Angeles",
});

const emptyResult: ExtractionResult = {
  tasks: [],
  ignoredStatements: [],
};

describe("fast formatted-task recovery", () => {
  it("recovers concrete email requests missed by an AI result", async () => {
    const result = await recoverConcreteFormattedTasks(
      input(`From: adviser@example.edu
Subject: Next steps
Please submit the waiver by Friday.
Could you call the office tomorrow?`),
      emptyResult,
    );

    expect(result.tasks.map((item) => item.title)).toEqual([
      "submit the waiver",
      "call the office",
    ]);
    expect(result.tasks.every((item) => item.id?.startsWith("recovered-format-"))).toBe(true);
  });

  it("does not duplicate a responsibility the AI already found", async () => {
    const existing = task({
      id: "ai-task",
      title: "Submit the waiver",
      sourceText: "Please submit the waiver by Friday.",
      dueDate: "2026-08-14",
      effortEstimateSource: "ai",
    });
    const result = await recoverConcreteFormattedTasks(
      input("Please submit the waiver by Friday."),
      { tasks: [existing], ignoredStatements: [] },
    );

    expect(result.tasks).toEqual([existing]);
  });

  it("does not recover noise, completed work, or negated requests", async () => {
    const result = await recoverConcreteFormattedTasks(
      input(`Project update
The office is closed Friday.
Do not submit the old form.
I already paid the invoice.`),
      emptyResult,
    );

    expect(result.tasks).toEqual([]);
  });

  it("recovers unchecked list items that have no dates", async () => {
    const result = await recoverConcreteFormattedTasks(
      input("☐ Read chapter 1\n[ ] Wash the lab coat"),
      emptyResult,
    );

    expect(result.tasks.map((item) => item.title)).toEqual([
      "Read chapter 1",
      "Wash the lab coat",
    ]);
  });
});
