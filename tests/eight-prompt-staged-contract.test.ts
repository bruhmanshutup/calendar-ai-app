import { describe, expect, it } from "vitest";
import type {
  ExtractedTask,
  ExtractionInput,
  ExtractionResult,
  PlanningRules,
  SourceEvidenceSpan,
} from "../lib/domain/types";
import { finalizeStagedExtraction } from "../lib/providers/staged-extraction";

const BASE = {
  currentLocalDate: "2026-08-31",
  timeZone: "America/Los_Angeles",
  sourceId: "eight-prompt-regression",
};

function task(
  patch: Partial<ExtractedTask> &
    Pick<ExtractedTask, "id" | "title" | "sourceText">,
): ExtractedTask {
  return {
    taskType: "flexible",
    responsibilityKind: "task",
    priority: "medium",
    category: "other",
    energyDemand: "medium",
    splittable: false,
    confidence: 0.9,
    fieldConfidence: { title: 0.96, taskType: 0.9 },
    missingInformation: [],
    reviewRequired: false,
    approved: true,
    ...patch,
  };
}

function locate(input: ExtractionInput, quote: string): SourceEvidenceSpan {
  const start = input.text.indexOf(quote);
  if (start < 0) throw new Error(`Missing fixture quote: ${quote}`);
  return {
    sourceId: input.sourceId,
    start,
    end: start + quote.length,
    quote,
  };
}

function stage(
  text: string,
  tasks: ExtractedTask[],
  planningRules?: PlanningRules,
): { input: ExtractionInput; result: ExtractionResult } {
  const input: ExtractionInput = { ...BASE, text };
  const withSpans = tasks.map((item) => ({
    ...item,
    sourceSpan: locate(input, item.sourceText),
  }));
  const result = finalizeStagedExtraction(
    input,
    { tasks: withSpans, ignoredStatements: [], planningRules },
    {
      responsibilities: withSpans.map((item, index) => ({
        key: item.id ?? `task-${index + 1}`,
        span: item.sourceSpan!,
        dependencies: item.dependencies ?? [],
      })),
      globalInstructions: [],
    },
    { addLocallyInferredDependencies: false },
  );
  for (const item of result.tasks) {
    expect(item.sourceSpan).toBeDefined();
    expect(input.text.slice(item.sourceSpan!.start, item.sourceSpan!.end)).toBe(
      item.sourceSpan!.quote,
    );
  }
  return { input, result };
}

function byId(result: ExtractionResult, id: string): ExtractedTask {
  const found = result.tasks.find((item) => item.id === id);
  if (!found) throw new Error(`Missing task ${id}`);
  return found;
}

describe("eight scheduling prompts: staged semantic contracts", () => {
  it("1. keeps deadlines, a fixed meeting, and a soft work window distinct", () => {
    const proposal =
      "Just a reminder that your design proposal is due Friday, September 4 at 11:59 PM.";
    const cad =
      "Before then, please send me your preliminary CAD drawings by Wednesday afternoon so I can review them.";
    const meeting =
      "We’ll meet Thursday at 2 PM for about an hour to go over feedback.";
    const edits =
      "If possible, try to make any final edits Thursday evening so you aren’t rushing Friday night.";
    const { result } = stage(
      `Hi Zach,\n${proposal} ${cad}\n${meeting} ${edits}\nThanks!`,
      [
        task({
          id: "proposal",
          title: "Complete design proposal",
          sourceText: proposal,
          dueDate: "2026-09-04",
          dueTime: "23:59",
          dueAt: "2026-09-05T06:59:00.000Z",
          deadlineStrength: "hard",
        }),
        task({
          id: "cad",
          title: "Send preliminary CAD drawings",
          sourceText: cad,
          dueDate: "2026-09-02",
          deadlineStrength: "hard",
          dueWindow: {
            start: "2026-09-02T19:00:00.000Z",
            end: "2026-09-03T00:00:00.000Z",
            label: "Wednesday afternoon",
            precision: "named_period",
          },
          dependencies: [
            { taskId: "proposal", relation: "before", strength: "hard" },
          ],
        }),
        task({
          id: "feedback",
          title: "Feedback meeting",
          sourceText: meeting,
          taskType: "fixed_time",
          responsibilityKind: "event",
          fixedStartAt: "2026-09-03T21:00:00.000Z",
          fixedEndAt: "2026-09-03T22:00:00.000Z",
          estimatedMinutes: 60,
          effortEstimateSource: "stated",
        }),
        task({
          id: "edits",
          title: "Make final edits",
          sourceText: edits,
          schedulingConstraints: {
            preferredDateWindows: [
              {
                start: "2026-09-04T00:00:00.000Z",
                end: "2026-09-04T04:00:00.000Z",
                label: "Thursday evening",
                precision: "named_period",
              },
            ],
          },
          dependencies: [
            { taskId: "feedback", relation: "after", strength: "hard" },
            { taskId: "proposal", relation: "before", strength: "hard" },
          ],
        }),
      ],
    );

    expect(byId(result, "proposal")).toMatchObject({
      taskType: "flexible",
      dueDate: "2026-09-04",
      dueTime: "23:59",
    });
    expect(byId(result, "proposal").fixedStartAt).toBeUndefined();
    expect(byId(result, "cad")).toMatchObject({
      dueDate: "2026-09-02",
      dueWindow: { precision: "named_period" },
    });
    expect(byId(result, "cad").dueTime).toBeUndefined();
    expect(byId(result, "feedback")).toMatchObject({
      taskType: "fixed_time",
      fixedStartAt: "2026-09-03T21:00:00.000Z",
      fixedEndAt: "2026-09-03T22:00:00.000Z",
    });
    expect(byId(result, "edits").dueDate).toBeUndefined();
    expect(byId(result, "edits").dependencies).toEqual([
      { taskId: "feedback", relation: "after", strength: "hard" },
      { taskId: "proposal", relation: "before", strength: "hard" },
    ]);
  });

  it("2. preserves prerequisite chains and a derived order-by boundary", () => {
    const calculations =
      "For the robotics project, finish the motor calculations before you start the CAD assembly.";
    const cadAndMeeting =
      "I’d like the calculations done by Tuesday, and the full CAD model needs to be ready before our team meeting Friday at 4 PM.";
    const bearings =
      "Also, order the bearings once the shaft diameter is finalized. Shipping usually takes 3–4 days, and we need the bearings by next Wednesday.";
    const { result } = stage(
      `${calculations} ${cadAndMeeting}\n${bearings}`,
      [
        task({
          id: "motor",
          title: "Finish motor calculations",
          sourceText: `${calculations} ${cadAndMeeting}`,
          dueDate: "2026-09-01",
          deadlineStrength: "hard",
        }),
        task({
          id: "cad",
          title: "Complete CAD assembly",
          sourceText: `${calculations} ${cadAndMeeting}`,
          dueDate: "2026-09-04",
          dueTime: "16:00",
          dueAt: "2026-09-04T23:00:00.000Z",
          deadlineStrength: "hard",
          dependencies: [
            { taskId: "motor", relation: "after", strength: "hard" },
            {
              taskId: "team-meeting",
              relation: "before",
              strength: "hard",
            },
          ],
        }),
        task({
          id: "team-meeting",
          title: "Robotics team meeting",
          sourceText: cadAndMeeting,
          taskType: "fixed_time",
          responsibilityKind: "event",
          fixedStartAt: "2026-09-04T23:00:00.000Z",
          reviewRequired: true,
          approved: false,
          missingInformation: ["Confirm the meeting duration"],
        }),
        task({
          id: "shaft",
          title: "Finalize shaft diameter",
          sourceText: bearings,
        }),
        task({
          id: "order-bearings",
          title: "Order bearings",
          description:
            "Latest order date is derived conservatively from the stated 3–4 day shipping range and September 9 arrival requirement.",
          sourceText: bearings,
          dueDate: "2026-09-05",
          deadlineStrength: "hard",
          dependencies: [
            { taskId: "shaft", relation: "after", strength: "hard" },
          ],
          fieldProvenance: [
            {
              path: "dueDate",
              origin: "derived",
              rationale:
                "Counted backward four days from the required September 9 arrival.",
            },
          ],
        }),
      ],
    );

    expect(result.tasks.map((item) => item.id)).toEqual([
      "motor",
      "cad",
      "team-meeting",
      "shaft",
      "order-bearings",
    ]);
    expect(byId(result, "motor").dueDate).toBe("2026-09-01");
    expect(byId(result, "cad").dependencies).toEqual(
      expect.arrayContaining([
        { taskId: "motor", relation: "after", strength: "hard" },
        {
          taskId: "team-meeting",
          relation: "before",
          strength: "hard",
        },
      ]),
    );
    expect(byId(result, "order-bearings")).toMatchObject({
      dueDate: "2026-09-05",
      dependencies: [
        { taskId: "shaft", relation: "after", strength: "hard" },
      ],
    });
    expect(
      byId(result, "order-bearings").fieldProvenance?.find(
        (item) => item.path === "dueDate",
      )?.origin,
    ).toBe("derived");
  });

  it("3. does not confuse a review milestone with the final lab deadline", () => {
    const milestone =
      "Can you get the lab report mostly finished this weekend? I want to look at it Monday morning.";
    const deadline =
      "The actual submission isn’t until next Wednesday at midnight, so don’t worry about making it perfect before Monday.";
    const citations =
      "Also, remind me sometime Tuesday to double-check the citations.";
    const { result } = stage(`${milestone} ${deadline}\n${citations}`, [
      task({
        id: "report",
        title: "Finish lab report",
        sourceText: `${milestone} ${deadline}`,
        dueDate: "2026-09-09",
        dueTime: "00:00",
        dueAt: "2026-09-09T07:00:00.000Z",
        deadlineStrength: "hard",
        schedulingConstraints: {
          preferredDateWindows: [
            {
              start: "2026-09-05T07:00:00.000Z",
              end: "2026-09-07T07:00:00.000Z",
              label: "This weekend",
              precision: "named_period",
            },
          ],
        },
      }),
      task({
        id: "review-copy",
        title: "Prepare lab report for review",
        sourceText: milestone,
        responsibilityKind: "milestone",
        deadlineStrength: "hard",
        dueDate: "2026-09-07",
        dueWindow: {
          start: "2026-09-07T15:00:00.000Z",
          end: "2026-09-07T19:00:00.000Z",
          label: "Monday morning",
          precision: "named_period",
        },
        dependencies: [
          { taskId: "report", relation: "before", strength: "hard" },
        ],
      }),
      task({
        id: "citations",
        title: "Double-check citations",
        sourceText: citations,
        responsibilityKind: "reminder",
        dueDate: "2026-09-08",
      }),
    ]);

    expect(byId(result, "report")).toMatchObject({
      dueDate: "2026-09-09",
      dueTime: "00:00",
    });
    expect(byId(result, "review-copy")).toMatchObject({
      dueDate: "2026-09-07",
      dueWindow: { label: "Monday morning" },
    });
    expect(byId(result, "review-copy").dueTime).toBeUndefined();
    expect(byId(result, "citations")).toMatchObject({
      dueDate: "2026-09-08",
    });
    expect(byId(result, "citations").dueTime).toBeUndefined();
  });

  it("4. keeps hard completion limits, a soft ordering preference, and dinner blackout separate", () => {
    const physics =
      "Tomorrow I need to work on physics and go to the gym. Physics is more important because the homework is due at 10 PM. I normally study for around two hours.";
    const gym =
      "The gym closes at 9 PM, and I usually spend about 75 minutes there. I’d rather go after I finish physics, but if there isn’t enough time, gym can happen first.";
    const dinner = "Don’t schedule anything during dinner from 6:00–6:45.";
    const { result } = stage(
      `${physics}\n${gym} ${dinner}`,
      [
        task({
          id: "physics",
          title: "Complete physics homework",
          sourceText: physics,
          dueDate: "2026-09-01",
          dueTime: "22:00",
          dueAt: "2026-09-02T05:00:00.000Z",
          deadlineStrength: "hard",
          estimatedMinutes: 120,
          effortEstimateSource: "stated",
          priority: "high",
        }),
        task({
          id: "gym",
          title: "Go to the gym",
          description:
            "Prefer after physics, but this ordering may be reversed if needed.",
          sourceText: `${physics}\n${gym}`,
          dueDate: "2026-09-01",
          dueTime: "21:00",
          dueAt: "2026-09-02T04:00:00.000Z",
          deadlineStrength: "hard",
          estimatedMinutes: 75,
          effortEstimateSource: "stated",
          dependencies: [
            { taskId: "physics", relation: "after", strength: "soft" },
          ],
        }),
      ],
      {
        blockedTimes: [
          {
            start: "2026-09-02T01:00:00.000Z",
            end: "2026-09-02T01:45:00.000Z",
            label: "Dinner",
          },
        ],
      },
    );

    expect(byId(result, "physics")).toMatchObject({
      dueTime: "22:00",
      estimatedMinutes: 120,
      priority: "high",
    });
    expect(byId(result, "gym")).toMatchObject({
      dueTime: "21:00",
      estimatedMinutes: 75,
      dependencies: [
        { taskId: "physics", relation: "after", strength: "soft" },
      ],
    });
    expect(result.planningRules?.blockedTimes).toEqual([
      {
        start: "2026-09-02T01:00:00.000Z",
        end: "2026-09-02T01:45:00.000Z",
        label: "Dinner",
      },
    ]);
    expect(result.tasks.some((item) => /more important/i.test(item.title))).toBe(
      false,
    );
  });

  it("5. preserves one recurring responsibility and its conditional duration", () => {
    const schedule =
      "Starting next week, I want to spend 45 minutes reviewing calculus every Monday, Wednesday, and Friday. Never put it before 10 AM, and ideally do it between classes rather than at night.";
    const endAndCondition =
      "This should continue until fall quarter finals week. If I have an exam the next day, extend the review to 90 minutes.";
    const { result } = stage(`${schedule}\n${endAndCondition}`, [
      task({
        id: "calculus-review",
        title: "Review calculus",
        sourceText: `${schedule}\n${endAndCondition}`,
        taskType: "recurring_goal",
        estimatedMinutes: 45,
        effortEstimateSource: "stated",
        schedulingConstraints: {
          allowedTimeWindows: [{ start: "10:00", end: "00:00" }],
          preferredTimeWindows: [{ start: "10:00", end: "17:00" }],
        },
        recurrence: {
          frequency: "weekly",
          mode: "quota",
          interval: 1,
          anchorDate: "2026-09-07",
          count: 3,
          daysOfWeek: ["monday", "wednesday", "friday"],
          windowStart: "2026-09-07T07:00:00.000Z",
        },
        conditionalRules: [
          {
            condition: "An exam is scheduled for the next day",
            effect: "Use a 90-minute review instead of 45 minutes",
            requiresReview: true,
          },
        ],
        reviewRequired: true,
        approved: false,
        missingInformation: [
          "Specify the date range for fall quarter finals week",
          "Conditional 90-minute review requires known exam dates",
        ],
      }),
    ]);

    expect(result.tasks).toHaveLength(1);
    expect(byId(result, "calculus-review")).toMatchObject({
      taskType: "recurring_goal",
      estimatedMinutes: 45,
      recurrence: {
        frequency: "weekly",
        anchorDate: "2026-09-07",
        daysOfWeek: ["monday", "wednesday", "friday"],
      },
      schedulingConstraints: {
        allowedTimeWindows: [{ start: "10:00", end: "00:00" }],
        preferredTimeWindows: [{ start: "10:00", end: "17:00" }],
      },
      conditionalRules: [
        {
          condition: "An exam is scheduled for the next day",
          effect: "Use a 90-minute review instead of 45 minutes",
          requiresReview: true,
        },
      ],
      reviewRequired: true,
    });
    expect(
      byId(result, "calculus-review").recurrence?.windowEnd,
    ).toBeUndefined();
    expect(byId(result, "calculus-review").missingInformation).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/finals week/i),
        expect.stringMatching(/exam dates/i),
      ]),
    );
  });

  it("6. accepts the newest correction and discards superseded Tuesday dates", () => {
    const presentation =
      "Professor: The presentation has been moved from Tuesday to Thursday at 1 PM.";
    const slides =
      "Slides still need to be sent to me the night before. Student: Does that mean Wednesday at midnight? Professor: Yes, but preferably earlier.";
    const summary =
      "Also, ignore my previous message saying the written summary was due Tuesday. That is now due Friday at 5 PM.";
    const { result } = stage(`${presentation} ${slides} ${summary}`, [
      task({
        id: "presentation",
        title: "Give presentation",
        sourceText: presentation,
        taskType: "fixed_time",
        responsibilityKind: "event",
        fixedStartAt: "2026-09-03T20:00:00.000Z",
        reviewRequired: true,
        approved: false,
        missingInformation: ["Confirm the presentation duration"],
      }),
      task({
        id: "slides",
        title: "Send presentation slides",
        sourceText: slides,
        dueDate: "2026-09-02",
        dueTime: "23:59",
        dueAt: "2026-09-03T06:59:00.000Z",
        deadlineStrength: "hard",
        schedulingConstraints: {
          preferredDateWindows: [
            {
              start: "2026-09-02T16:00:00.000Z",
              end: "2026-09-03T00:00:00.000Z",
              label: "Earlier Wednesday",
              precision: "approximate",
            },
          ],
        },
        dependencies: [
          { taskId: "presentation", relation: "before", strength: "hard" },
        ],
      }),
      task({
        id: "summary",
        title: "Submit written summary",
        sourceText: summary,
        dueDate: "2026-09-04",
        dueTime: "17:00",
        dueAt: "2026-09-05T00:00:00.000Z",
        deadlineStrength: "hard",
      }),
    ]);

    expect(byId(result, "presentation")).toMatchObject({
      fixedStartAt: "2026-09-03T20:00:00.000Z",
    });
    expect(byId(result, "presentation").dueDate).toBeUndefined();
    expect(byId(result, "slides")).toMatchObject({
      dueDate: "2026-09-02",
      dueTime: "23:59",
    });
    expect(byId(result, "summary")).toMatchObject({
      dueDate: "2026-09-04",
      dueTime: "17:00",
    });
    expect(result.tasks.some((item) => item.dueDate === "2026-09-01")).toBe(
      false,
    );
  });

  it("7. keeps Saturday windows and durations without turning a buffer into a task", () => {
    const heading = "On Saturday I want to:";
    const coding = "Finish my coding assignment before 5 PM";
    const chemistry = "Study chemistry for at least 90 minutes";
    const groceries =
      "Pick up groceries sometime after 11 AM but before the store closes at 8 PM";
    const call = "Call Alex after 3 PM; should only take 20 minutes";
    const buffer = "Leave 30 minutes between studying and coding so I can eat";
    const details =
      "Coding will probably take 2–3 hours. Chemistry should happen before coding if possible.";
    const source = `${heading}\n- ${coding}\n- ${chemistry}\n- ${groceries}\n- ${call}\n- ${buffer}\n${details}`;
    const { result } = stage(source, [
      task({
        id: "coding",
        title: "Finish coding assignment",
        sourceText: source,
        dueDate: "2026-09-05",
        dueTime: "17:00",
        dueAt: "2026-09-06T00:00:00.000Z",
        estimatedMinutes: 180,
        durationRange: {
          minimumMinutes: 120,
          maximumMinutes: 180,
          preferredMinutes: 180,
        },
        effortEstimateSource: "stated",
        description:
          "The source states a 2–3 hour range; 180 minutes is the conservative planning value. Preserve a 30-minute meal buffer from chemistry and prefer chemistry first.",
        dependencies: [
          {
            taskId: "chemistry",
            relation: "after",
            strength: "soft",
            minimumGapMinutes: 30,
          },
        ],
        schedulingConstraints: {
          allowedDateWindows: [
            {
              start: "2026-09-05T07:00:00.000Z",
              end: "2026-09-06T07:00:00.000Z",
              label: "Saturday",
              precision: "exact",
            },
          ],
        },
      }),
      task({
        id: "chemistry",
        title: "Study chemistry",
        sourceText: source,
        dueDate: "2026-09-05",
        estimatedMinutes: 90,
        minimumSessionMinutes: 90,
        effortEstimateSource: "stated",
        schedulingConstraints: {
          allowedDateWindows: [
            {
              start: "2026-09-05T07:00:00.000Z",
              end: "2026-09-06T07:00:00.000Z",
              label: "Saturday",
              precision: "exact",
            },
          ],
        },
      }),
      task({
        id: "groceries",
        title: "Pick up groceries",
        sourceText: groceries,
        dueDate: "2026-09-05",
        dueTime: "20:00",
        dueAt: "2026-09-06T03:00:00.000Z",
        schedulingConstraints: {
          allowedTimeWindows: [{ start: "11:00", end: "20:00" }],
          allowedDateWindows: [
            {
              start: "2026-09-05T07:00:00.000Z",
              end: "2026-09-06T07:00:00.000Z",
              label: "Saturday",
              precision: "exact",
            },
          ],
        },
      }),
      task({
        id: "call-alex",
        title: "Call Alex",
        sourceText: call,
        dueDate: "2026-09-05",
        estimatedMinutes: 20,
        minimumSessionMinutes: 20,
        effortEstimateSource: "stated",
        schedulingConstraints: {
          allowedTimeWindows: [{ start: "15:00", end: "00:00" }],
          allowedDateWindows: [
            {
              start: "2026-09-05T07:00:00.000Z",
              end: "2026-09-06T07:00:00.000Z",
              label: "Saturday",
              precision: "exact",
            },
          ],
        },
      }),
    ]);

    expect(result.tasks).toHaveLength(4);
    expect(byId(result, "coding")).toMatchObject({
      dueTime: "17:00",
      estimatedMinutes: 180,
      durationRange: {
        minimumMinutes: 120,
        maximumMinutes: 180,
        preferredMinutes: 180,
      },
    });
    expect(byId(result, "chemistry")).toMatchObject({
      estimatedMinutes: 90,
      minimumSessionMinutes: 90,
    });
    expect(byId(result, "groceries").schedulingConstraints).toMatchObject({
      allowedTimeWindows: [{ start: "11:00", end: "20:00" }],
      allowedDateWindows: [expect.objectContaining({ label: "Saturday" })],
    });
    expect(byId(result, "call-alex")).toMatchObject({
      estimatedMinutes: 20,
      schedulingConstraints: {
        allowedTimeWindows: [{ start: "15:00", end: "00:00" }],
        allowedDateWindows: [expect.objectContaining({ label: "Saturday" })],
      },
    });
    expect(result.tasks.some((item) => /leave 30 minutes/i.test(item.title))).toBe(
      false,
    );
  });

  it("8. preserves ambiguity and refuses to invent exact Thursday times", () => {
    const essay =
      "I should probably work on the essay early next week. It’s due sometime Thursday, I think.";
    const meeting =
      "I have a meeting Thursday afternoon, though, so I definitely want it done before that.";
    const { result } = stage(`${essay} ${meeting}`, [
      task({
        id: "essay",
        title: "Complete essay",
        sourceText: `${essay} ${meeting}`,
        dueDate: "2026-09-10",
        schedulingConstraints: {
          preferredDateWindows: [
            {
              start: "2026-09-07T07:00:00.000Z",
              end: "2026-09-10T07:00:00.000Z",
              label: "Early next week",
              precision: "approximate",
            },
          ],
        },
        dependencies: [
          {
            taskId: "thursday-meeting",
            relation: "before",
            strength: "hard",
          },
        ],
        confidence: 0.62,
        reviewRequired: true,
        approved: false,
        missingInformation: [
          "Confirm the exact essay deadline time",
          "Confirm the Thursday meeting time",
        ],
      }),
      task({
        id: "thursday-meeting",
        title: "Thursday meeting",
        sourceText: meeting,
        taskType: "fixed_time",
        responsibilityKind: "event",
        occurrenceWindow: {
          start: "2026-09-10T19:00:00.000Z",
          end: "2026-09-11T00:00:00.000Z",
          label: "Thursday afternoon",
          precision: "named_period",
        },
        confidence: 0.58,
        reviewRequired: true,
        approved: false,
        missingInformation: [
          "Confirm the exact meeting start time and duration",
        ],
      }),
    ]);

    expect(byId(result, "essay")).toMatchObject({
      dueDate: "2026-09-10",
      reviewRequired: true,
    });
    expect(byId(result, "essay").dueTime).toBeUndefined();
    expect(byId(result, "essay").dueAt).toBeUndefined();
    expect(byId(result, "essay").fixedStartAt).toBeUndefined();
    expect(byId(result, "thursday-meeting")).toMatchObject({
      taskType: "fixed_time",
      reviewRequired: true,
    });
    expect(byId(result, "thursday-meeting").fixedStartAt).toBeUndefined();
    expect(byId(result, "thursday-meeting").fixedEndAt).toBeUndefined();
    expect(
      result.tasks.flatMap((item) => [
        item.dueTime,
        item.dueAt,
        item.fixedStartAt,
        item.fixedEndAt,
      ]),
    ).toEqual(expect.not.arrayContaining([expect.any(String)]));
  });
});
