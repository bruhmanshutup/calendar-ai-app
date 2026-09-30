import { describe, expect, it } from "vitest";
import type { ExtractionInput } from "../lib/domain/types";
import { shouldUseFastLocalExtraction } from "../lib/providers/extraction-strategy";
import { MockTaskExtractionProvider } from "../lib/providers/mock-extraction";

const base = {
  currentLocalDate: "2026-08-17",
  timeZone: "America/Los_Angeles",
};

async function decision(text: string) {
  const input: ExtractionInput = { ...base, text };
  const local = await new MockTaskExtractionProvider().extractTasks(input);
  return shouldUseFastLocalExtraction(input, local);
}

describe("hybrid extraction strategy", () => {
  it.each([
    "Please pay rent tomorrow. 10 minutes.",
    "[9:13 AM] Sam: Can you review the landing page by Friday?",
    "☐ Update comps by tomorrow at 6 AM. 45 mins.",
    "Dentist appointment Tuesday at 2 PM for 45 minutes.",
    "Take medication every day at 8 AM.",
  ])("keeps a straightforward responsibility on the fast local path", async (text) => {
    expect(await decision(text)).toBe(true);
  });

  it.each([
    "Before that meeting, review the deck for 45 minutes, and then send the notes to Legal.",
    "Finish the model by Friday. Split it into three sessions across the week if possible.",
    "I prefer afternoons, but do not schedule anything after 6 PM.",
    "Team meeting Friday at 8.",
    "Exercise every day in the morning.",
  ])("uses AI when prose or missing detail changes scheduling materially", async (text) => {
    expect(await decision(text)).toBe(false);
  });

  it("does not trust a long paragraph with several independent actions", async () => {
    const text = `${"Background context. ".repeat(20)}Please review the model, email Legal, and submit the memo by Friday.`;
    expect(await decision(text)).toBe(false);
  });

  it("trusts an explicitly indexed learning plan even when surrounding resources make it long", async () => {
    const resources = Array.from(
      { length: 80 },
      (_, index) =>
        `Resource ${index + 1}: https://example.com/tutorial/${index + 1} ${"background reading ".repeat(14)}`,
    ).join("\n");
    const text = `Week 1 – Foundations
${resources}
Daily checklist:
Day 1: Read the overview.
Day 2: Watch the lesson.
Week 2 – Practice
Daily checklist:
Day 1: Build the example.
Day 2: Write the summary.`;

    expect(text.length).toBeGreaterThan(20_000);
    expect(await decision(text)).toBe(true);
  });
});
