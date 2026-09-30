import { describe, expect, it } from "vitest";

import type {
  ExtractedTask,
  ExtractionInput,
  ExtractionResult,
} from "../lib/domain/types";
import { recoverTemporalRoles } from "../lib/providers/temporal-role-recovery";

const EMAIL = `Hi Zach,

Just a reminder that your design proposal is due Friday, September 4 at 11:59 PM. Before then, please send me your preliminary CAD drawings by Wednesday afternoon so I can review them.

We’ll meet Thursday at 2 PM for about an hour to go over feedback. If possible, try to make any final edits Thursday evening so you aren’t rushing Friday night.

Thanks!`;

const input: ExtractionInput = {
  text: EMAIL,
  currentLocalDate: "2026-08-29",
  timeZone: "America/Los_Angeles",
  sourceId: "email-paste",
};

function task(
  id: string,
  title: string,
  sourceText: string,
  malformed: Partial<ExtractedTask> = {},
): ExtractedTask {
  return {
    id,
    title,
    taskType: "flexible",
    estimatedMinutes: 45,
    effortEstimateSource: "ai",
    effortEstimateRationale: "Provider guess.",
    priority: "medium",
    category: "school",
    energyDemand: "medium",
    splittable: false,
    minimumSessionMinutes: 30,
    confidence: 0.8,
    fieldConfidence: {
      title: 0.9,
      taskType: 0.6,
      estimatedMinutes: 0.5,
      priority: 0.7,
    },
    missingInformation: [],
    sourceText,
    approved: true,
    reviewRequired: false,
    ...malformed,
  };
}

function emailResult(): ExtractionResult {
  return {
    tasks: [
      task(
        "proposal",
        "Finish design proposal",
        "Just a reminder that your design proposal is due Friday, September 4 at 11:59 PM.",
        {
          taskType: "fixed_time",
          fixedStartAt: "2026-09-05T06:59:00.000Z",
          fixedEndAt: "2026-09-05T08:29:00.000Z",
          missingInformation: ["Confirm effort estimate"],
          approved: false,
          reviewRequired: true,
        },
      ),
      task(
        "cad",
        "Send preliminary CAD drawings",
        "Before then, please send me your preliminary CAD drawings by Wednesday afternoon so I can review them.",
        {
          dueDate: "2026-09-02",
          dueTime: "17:00",
          dueAt: "2026-09-03T00:00:00.000Z",
        },
      ),
      task(
        "meeting",
        "Meet to review feedback",
        "We’ll meet Thursday at 2 PM for about an hour to go over feedback.",
        {
          dueDate: "2026-09-03",
          dueTime: "14:00",
          dueAt: "2026-09-03T21:00:00.000Z",
          missingInformation: ["Confirm whether this is a deadline or event"],
          approved: false,
          reviewRequired: true,
        },
      ),
      task(
        "edits",
        "Make final edits",
        "If possible, try to make any final edits Thursday evening so you aren’t rushing Friday night.",
        {
          taskType: "fixed_time",
          fixedStartAt: "2026-09-04T00:00:00.000Z",
          fixedEndAt: "2026-09-04T00:45:00.000Z",
          dueDate: "2026-09-03",
          dueTime: "17:00",
          dueAt: "2026-09-04T00:00:00.000Z",
        },
      ),
    ],
    ignoredStatements: [],
  };
}

describe("temporal role recovery", () => {
  it("distinguishes exact deadlines, vague due windows, fixed events, and dated preferences", () => {
    const recovered = recoverTemporalRoles(input, emailResult());

    expect(recovered.tasks).toHaveLength(4);
    expect(recovered.tasks.map((value) => value.id)).toEqual([
      "proposal",
      "cad",
      "meeting",
      "edits",
    ]);

    const proposal = recovered.tasks[0];
    expect(proposal).toMatchObject({
      taskType: "flexible",
      dueDate: "2026-09-04",
      dueTime: "23:59",
      dueAt: "2026-09-05T06:59:00.000Z",
      approved: true,
      reviewRequired: false,
      missingInformation: [],
    });
    expect(proposal.fixedStartAt).toBeUndefined();
    expect(proposal.dueWindow).toBeUndefined();

    const cad = recovered.tasks[1];
    expect(cad).toMatchObject({
      taskType: "flexible",
      dueDate: "2026-09-02",
      dueWindow: {
        start: "2026-09-02T19:00:00.000Z",
        end: "2026-09-03T00:00:00.000Z",
        label: "Wednesday afternoon",
        precision: "named_period",
      },
    });
    expect(cad.dueTime).toBeUndefined();
    expect(cad.dueAt).toBeUndefined();

    const meeting = recovered.tasks[2];
    expect(meeting).toMatchObject({
      taskType: "fixed_time",
      fixedStartAt: "2026-09-03T21:00:00.000Z",
      fixedEndAt: "2026-09-03T22:00:00.000Z",
      estimatedMinutes: 60,
      minimumSessionMinutes: 60,
      effortEstimateSource: "stated",
      approved: true,
      reviewRequired: false,
      missingInformation: [],
    });
    expect(meeting.dueDate).toBeUndefined();
    expect(meeting.dueAt).toBeUndefined();

    const edits = recovered.tasks[3];
    expect(edits.taskType).toBe("flexible");
    expect(edits.dueDate).toBeUndefined();
    expect(edits.fixedStartAt).toBeUndefined();
    expect(edits.schedulingConstraints?.preferredDateWindows).toEqual([
      {
        start: "2026-09-04T00:00:00.000Z",
        end: "2026-09-04T04:00:00.000Z",
        label: "Thursday evening",
        precision: "named_period",
      },
    ]);
    expect(
      edits.schedulingConstraints?.preferredDateWindows?.some((window) =>
        /friday/i.test(window.label),
      ),
    ).toBe(false);
  });

  it("repairs malformed provider roles in place and records explicit evidence", () => {
    const malformed = emailResult();
    const recovered = recoverTemporalRoles(input, malformed);
    const meeting = recovered.tasks.find((value) => value.id === "meeting")!;
    const fixedStart = meeting.fieldProvenance?.find(
      (field) => field.path === "fixedStartAt",
    );

    expect(recovered.tasks).toHaveLength(malformed.tasks.length);
    expect(new Set(recovered.tasks.map((value) => value.id)).size).toBe(4);
    expect(fixedStart).toMatchObject({
      origin: "explicit",
      evidence: [
        expect.objectContaining({
          sourceId: "email-paste",
          quote:
            "We’ll meet Thursday at 2 PM for about an hour to go over feedback.",
        }),
      ],
    });
  });

  it("does not turn meeting-management actions or 'meet the deadline' into fixed events", () => {
    const exclusionInput: ExtractionInput = {
      ...input,
      text: `Please meet the deadline Friday at 5 PM.\nSchedule a meeting Thursday at 2 PM.\nCancel the meeting Friday at 3 PM.`,
    };
    const result: ExtractionResult = {
      tasks: [
        task("deadline", "Meet the deadline", "Please meet the deadline Friday at 5 PM."),
        task("schedule", "Schedule a meeting", "Schedule a meeting Thursday at 2 PM."),
        task("cancel", "Cancel the meeting", "Cancel the meeting Friday at 3 PM."),
      ],
      ignoredStatements: [],
    };

    const recovered = recoverTemporalRoles(exclusionInput, result);
    expect(recovered.tasks[0]).toMatchObject({
      id: "deadline",
      taskType: "flexible",
      dueDate: "2026-09-04",
      dueTime: "17:00",
    });
    expect(recovered.tasks[0].fixedStartAt).toBeUndefined();
    expect(recovered.tasks.slice(1)).toEqual(result.tasks.slice(1));
  });

  it("keeps a fixed event in review when its end cannot be derived safely", () => {
    const noDurationInput: ExtractionInput = {
      ...input,
      text: "We'll meet Thursday at 2 PM to discuss feedback.",
    };
    const result: ExtractionResult = {
      tasks: [
        task(
          "meeting",
          "Discuss feedback",
          "We'll meet Thursday at 2 PM to discuss feedback.",
        ),
      ],
      ignoredStatements: [],
    };
    const [meeting] = recoverTemporalRoles(noDurationInput, result).tasks;

    expect(meeting).toMatchObject({
      taskType: "fixed_time",
      fixedStartAt: "2026-09-03T21:00:00.000Z",
      fixedEndAt: undefined,
      approved: false,
      reviewRequired: true,
      missingInformation: ["Confirm the event duration"],
    });
  });
});
