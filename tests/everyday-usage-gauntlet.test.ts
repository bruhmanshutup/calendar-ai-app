import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import type { ExtractedTask } from "../lib/domain/types";
import { MockTaskExtractionProvider } from "../lib/providers/mock-extraction";

const base = {
  currentLocalDate: "2026-08-17",
  timeZone: "America/Los_Angeles",
};

type Scenario = {
  name: string;
  text: string;
  title: RegExp;
  exactTitle?: string;
  taskType?: ExtractedTask["taskType"];
  dueDate?: string;
  dueTime?: string;
  estimatedMinutes?: number;
  priority?: ExtractedTask["priority"];
};

const scenarios: Record<string, Scenario[]> = {
  "home and personal": [
    {
      name: "friendly reminder",
      text: "Hey, could you please remind me to pay the electricity bill tomorrow? Thanks!",
      title: /pay.*electricity bill/i,
      exactTitle: "pay the electricity bill",
      dueDate: "2026-08-18",
    },
    {
      name: "frustrated casual speech",
      text: "Ugh, I gotta clean the kitchen tonight. Should take 25 mins.",
      title: /clean the kitchen/i,
      exactTitle: "clean the kitchen",
      dueDate: "2026-08-17",
      estimatedMinutes: 25,
    },
    {
      name: "soft intention with a gerund",
      text: "I should probably get around to renewing my passport.",
      title: /renew my passport/i,
      exactTitle: "renew my passport",
    },
    {
      name: "short pickup request",
      text: "Pls pick up the prescription Friday.",
      title: /pick up the prescription/i,
      dueDate: "2026-08-21",
    },
    {
      name: "fixed appointment",
      text: "Dentist appointment Tuesday at 2 PM for 45 minutes.",
      title: /dentist appointment/i,
      taskType: "fixed_time",
      estimatedMinutes: 45,
    },
    {
      name: "family practice",
      text: "Soccer practice Tuesday at 5:30 PM for 90 minutes.",
      title: /soccer practice/i,
      taskType: "fixed_time",
      estimatedMinutes: 90,
    },
    {
      name: "social meal",
      text: "Dinner with Ana Friday at 7 PM for 90 minutes.",
      title: /dinner with ana/i,
      taskType: "fixed_time",
    },
    {
      name: "urgent repair",
      text: "ASAP — fix the leaking sink.",
      title: /fix the leaking sink/i,
      exactTitle: "fix the leaking sink",
      priority: "urgent",
    },
  ],
  "work from home": [
    {
      name: "chat request",
      text: "[9:13 AM] Sam: Can you review the landing page by Friday?",
      title: /review the landing page/i,
      dueDate: "2026-08-21",
    },
    {
      name: "focus work estimate",
      text: "Need to draft the launch brief by Thursday. About 90 mins.",
      title: /draft the launch brief/i,
      dueDate: "2026-08-20",
      estimatedMinutes: 90,
    },
    {
      name: "polite handoff",
      text: "Would you mind sending Priya the revised mockups tomorrow?",
      title: /send priya the revised mockups/i,
      exactTitle: "send Priya the revised mockups",
      dueDate: "2026-08-18",
    },
    {
      name: "explicit call commitment",
      text: "Client call Thursday at 8 AM for 30 minutes.",
      title: /client call/i,
      taskType: "fixed_time",
      estimatedMinutes: 30,
    },
    {
      name: "completed chat request",
      text: "No need to join the vendor call; I already handled it.",
      title: /$a/,
    },
  ],
  corporate: [
    {
      name: "formal request",
      text: "Kindly circulate the revised SOW to Legal by Monday.",
      title: /circulate the revised sow to legal/i,
      dueDate: "2026-08-17",
    },
    {
      name: "hedged board deliverable",
      text: "Would you mind preparing the board pre-read by August 20? It should take 90 minutes.",
      title: /prepare the board pre-read/i,
      exactTitle: "prepare the board pre-read",
      dueDate: "2026-08-20",
      estimatedMinutes: 90,
    },
    {
      name: "action-item shorthand",
      text: "Action item: obtain Legal sign-off by 8/21.",
      title: /obtain legal sign-off/i,
      dueDate: "2026-08-21",
    },
    {
      name: "executive meeting",
      text: "ELT meeting Friday at 9 AM for 30 minutes.",
      title: /elt meeting/i,
      taskType: "fixed_time",
    },
    {
      name: "cancellation is work, not the cancelled event",
      text: "Cancel the steering committee meeting Thursday at 11 AM.",
      title: /cancel the steering committee meeting/i,
      taskType: "flexible",
      dueDate: "2026-08-20",
    },
    {
      name: "informational corporate note",
      text: "FYI: the steering committee moved to Thursday.",
      title: /$a/,
    },
  ],
  "investment banking": [
    {
      name: "terse comps request",
      text: "Pls update comps by tomorrow at 6 AM. 45 mins.",
      title: /update comps/i,
      dueDate: "2026-08-18",
      dueTime: "06:00",
      estimatedMinutes: 45,
    },
    {
      name: "deal-team idiom",
      text: "Turn the MD comments on the CIM by Friday. 2 hrs.",
      title: /turn the md comments on the cim/i,
      dueDate: "2026-08-21",
      estimatedMinutes: 120,
    },
    {
      name: "buyer list handoff",
      text: "Send the buyer list before Monday. 15 mins.",
      title: /send the buyer list/i,
      dueDate: "2026-08-17",
      estimatedMinutes: 15,
    },
    {
      name: "investment committee meeting",
      text: "IC meeting Monday at 4 PM for 1 hour.",
      title: /ic meeting/i,
      taskType: "fixed_time",
      estimatedMinutes: 60,
    },
    {
      name: "do-not-redo instruction",
      text: "No need to rerun the model; already done.",
      title: /$a/,
    },
  ],
  "tone and format variants": [
    {
      name: "direct command",
      text: "Submit the expense report today.",
      title: /submit the expense report/i,
      dueDate: "2026-08-17",
    },
    {
      name: "all caps reminder",
      text: "REMINDER: SUBMIT TIMESHEET TOMORROW",
      title: /submit timesheet/i,
      dueDate: "2026-08-18",
    },
    {
      name: "slang request",
      text: "yo can u call mom Friday",
      title: /call mom/i,
      dueDate: "2026-08-21",
    },
    {
      name: "low-pressure wish",
      text: "Maybe someday I'd like to read The Design of Everyday Things.",
      title: /read the design of everyday things/i,
      exactTitle: "read The Design of Everyday Things",
    },
    {
      name: "passive voice",
      text: "The invoice needs to be paid Friday.",
      title: /invoice needs to be paid/i,
      dueDate: "2026-08-21",
    },
    {
      name: "checkbox shorthand",
      text: "☐ Renew car registration 8/31/2026",
      title: /renew car registration/i,
      dueDate: "2026-08-31",
    },
    {
      name: "negated command",
      text: "Do not submit the old forecast.",
      title: /$a/,
    },
    {
      name: "recurring health instruction",
      text: "Take medication every day at 8 AM.",
      title: /take medication/i,
      taskType: "recurring_goal",
    },
  ],
};

const extractor = new MockTaskExtractionProvider();

describe.each(Object.entries(scenarios))("everyday usage: %s", (_persona, cases) => {
  it.each(cases)("understands $name", async (scenario) => {
    const result = await extractor.extractTasks({ ...base, text: scenario.text });
    const task = result.tasks.find((candidate) => scenario.title.test(candidate.title));

    if (scenario.title.source === "$a") {
      expect(result.tasks).toHaveLength(0);
      return;
    }

    expect(task, JSON.stringify(result.tasks, null, 2)).toBeDefined();
    if (scenario.exactTitle) expect(task?.title).toBe(scenario.exactTitle);
    if (scenario.taskType) expect(task?.taskType).toBe(scenario.taskType);
    if (scenario.dueDate) expect(task?.dueDate).toBe(scenario.dueDate);
    if (scenario.dueTime) expect(task?.dueTime).toBe(scenario.dueTime);
    if (scenario.estimatedMinutes) {
      expect(task?.estimatedMinutes).toBe(scenario.estimatedMinutes);
    }
    if (scenario.priority) expect(task?.priority).toBe(scenario.priority);
  });
});

describe("interactive-path performance", () => {
  it("interprets 100 mixed-style responsibilities within a tight local budget", async () => {
    const templates = [
      "Please review client memo {n} by Friday. 30 minutes.",
      "☐ Pay invoice {n} tomorrow. 10 mins.",
      "Need to update model {n} by Thursday. 45 mins.",
      "Call vendor {n} Wednesday at 3 PM for 15 minutes.",
    ];
    const text = Array.from({ length: 100 }, (_, index) =>
      templates[index % templates.length].replace("{n}", String(index + 1)),
    ).join("\n");

    const started = performance.now();
    const result = await extractor.extractTasks({ ...base, text });
    const elapsed = performance.now() - started;

    expect(result.tasks).toHaveLength(100);
    expect(elapsed).toBeLessThan(250);
  });
});
