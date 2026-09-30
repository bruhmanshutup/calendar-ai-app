import { describe, expect, it } from "vitest";
import { MockTaskExtractionProvider } from "../lib/providers/mock-extraction";

/**
 * A small, intentional regression corpus for inputs users actually paste.
 * Each case targets one failure mode: transport noise, LMS formatting,
 * conversational language, OCR/typos, or misleading context.
 *
 * Keep this file as the review checklist for future extraction changes. These
 * are local-provider contract tests; live-provider quality belongs in the
 * opt-in scripts under scripts/.
 */
const input = {
  currentLocalDate: "2026-08-12",
  timeZone: "America/Los_Angeles",
};

const cases = [
  {
    name: "Canvas export keeps assignment rows and ignores navigation chrome",
    text: `Canvas\nDashboard\nCourses\nBIO 101\nAssignments\nLab report: enzyme kinetics\nDue: Aug 18, 11:59 PM\n20 points\nAnnouncements\nYou have 3 missing assignments`,
    expectedTitles: ["Lab report: enzyme kinetics"],
    expectedDueDates: ["2026-08-18"],
  },
  {
    name: "email thread keeps the newest request and drops quoted history",
    text: `Subject: Re: recommendation letter\nCan you send the final draft by Friday?\n\nOn Tue, Maya wrote:\n> Can you send a rough draft by Wednesday?`,
    expectedTitles: ["send the final draft"],
    expectedDueDates: ["2026-08-14"],
  },
  {
    name: "chat dialogue strips speaker and preserves a polite request",
    text: `[9:04 AM] Maya: hey, could you upload the revised budget by tomorrow?\n[9:05 AM] Zach: sure`,
    expectedTitles: ["upload the revised budget"],
    expectedDueDates: ["2026-08-13"],
  },
  {
    name: "OCR-like bullets stay bounded and do not turn metadata into work",
    text: `\u2022​ Submit the safety form 8/15/26\n\u2192\u00a0Call the lab office Monday\nLast synced: 8/12/26`,
    expectedTitles: ["Submit the safety form", "Call the lab office"],
    expectedDueDates: ["2026-08-15", "2026-08-17"],
  },
  {
    name: "ambiguous typo is retained for review instead of silently invented",
    text: `pls submt the lab waivr by tomorow maybe 20 mins?`,
    expectedTitles: [],
    expectedDueDates: [],
  },
] as const;

describe("messy input interpretation benchmark", () => {
  for (const scenario of cases) {
    it(scenario.name, async () => {
      const result = await new MockTaskExtractionProvider().extractTasks({
        ...input,
        text: scenario.text,
      });

      expect(result.tasks.map((task) => task.title)).toEqual(
        scenario.expectedTitles,
      );
      expect(result.tasks.map((task) => task.dueDate)).toEqual(
        scenario.expectedDueDates,
      );
      expect(result.tasks.length).toBeLessThanOrEqual(100);
    });
  }

  it.todo(
    "spell-corrects high-confidence action verbs while preserving the original quote and review flag",
  );
});
