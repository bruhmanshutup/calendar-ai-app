import { describe, expect, it } from "vitest";

import { generateSchedule } from "../lib/domain/scheduler";
import type { ExtractionInput } from "../lib/domain/types";
import { compileSemanticDraft } from "../lib/providers/semantic-draft-compiler";
import {
  semanticDraftSchema,
  type SemanticDraft,
} from "../lib/providers/semantic-draft";
import { TEST_PREFERENCES } from "./fixtures";

type DraftResponsibility = SemanticDraft["responsibilities"][number];
type DraftRelation = SemanticDraft["relations"][number];

const BASE_INPUT = {
  currentLocalDate: "2026-09-02",
  timeZone: "America/Los_Angeles",
  sourceId: "semantic-draft-compiler-test",
};

function responsibility(
  patch: Partial<DraftResponsibility> &
    Pick<DraftResponsibility, "id" | "title" | "kind" | "sourceText">,
): DraftResponsibility {
  return {
    confidence: 0.94,
    missingInformation: [],
    reviewRequired: false,
    ...patch,
  };
}

function compile(
  text: string,
  responsibilities: DraftResponsibility[],
  relations: DraftRelation[] = [],
) {
  const input: ExtractionInput = { ...BASE_INPUT, text };
  const locatedResponsibilities = responsibilities.map((item) => {
    const sourceStart = text.indexOf(item.sourceText);
    if (sourceStart < 0) {
      throw new Error(`Fixture source text not found: ${item.sourceText}`);
    }
    return {
      ...item,
      sourceStart,
      sourceEnd: sourceStart + item.sourceText.length,
    };
  });
  const draft = semanticDraftSchema.parse({
    responsibilities: locatedResponsibilities,
    relations,
    blockedTimes: [],
    globalInstructions: [],
    ignoredStatements: [],
  });
  return compileSemanticDraft(input, draft);
}

describe("semantic draft normalization and compiler", () => {
  it("schedules active weekdays when an except-clause conflicts with a redundant weekday filter", () => {
    const source =
      "Exercise every day except Friday and Saturday from 6-8 PM starting today.";
    const result = compile(source, [
      responsibility({
        id: "exercise-recurring",
        title: "Exercise",
        kind: "event",
        sourceText: source,
        duration: {
          minimumMinutes: 120,
          preferredMinutes: 120,
          maximumMinutes: 120,
          explicit: true,
        },
        recurrence: {
          frequency: "daily",
          interval: 1,
          startDate: "2026-09-02",
          // This reproduces the contradictory provider fields that previously
          // made the scheduler filter for the two excluded days.
          daysOfWeek: ["friday", "saturday"],
          exactTimes: [
            {
              daysOfWeek: [
                "sunday",
                "monday",
                "tuesday",
                "wednesday",
                "thursday",
              ],
              time: "18:00",
            },
          ],
        },
        planning: {
          estimatedMinutes: 120,
          priority: "medium",
          category: "fitness",
          energyDemand: "medium",
          splittable: false,
        },
      }),
    ]);

    expect(result.tasks[0].recurrence?.daysOfWeek).toEqual([
      "sunday",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
    ]);

    const availability = Array.from({ length: 7 }, (_, index) => {
      const utcDay = String(index + 3).padStart(2, "0");
      return {
        start: `2026-09-${utcDay}T01:00:00.000Z`,
        end: `2026-09-${utcDay}T03:00:00.000Z`,
      };
    });
    const proposal = generateSchedule({
      windowStart: "2026-09-02T07:00:00.000Z",
      windowEnd: "2026-09-09T07:00:00.000Z",
      tasks: result.tasks,
      preferences: {
        ...TEST_PREFERENCES,
        timeZone: "America/Los_Angeles",
        wakingTime: "00:00",
        sleepingTime: "23:59",
      },
      availability,
      unavailableEvents: [],
      blockedTimes: [],
      lockedSessions: [],
    });

    expect(proposal.sessions.map((session) => session.start)).toEqual([
      "2026-09-03T01:00:00.000Z",
      "2026-09-04T01:00:00.000Z",
      "2026-09-07T01:00:00.000Z",
      "2026-09-08T01:00:00.000Z",
      "2026-09-09T01:00:00.000Z",
    ]);
  });

  it("compiles local event dates and times into offset-aware instants", () => {
    const source = "Architecture review is Thursday from 2 PM until 3 PM.";
    const result = compile(source, [
      responsibility({
        id: "architecture-review",
        title: "Architecture review",
        kind: "event",
        sourceText: source,
        occurrence: {
          date: "2026-09-03",
          startTime: "14:00",
          endTime: "15:00",
          confidence: 0.98,
        },
      }),
    ]);

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      taskType: "fixed_time",
      responsibilityKind: "event",
      fixedStartAt: "2026-09-03T21:00:00.000Z",
      fixedEndAt: "2026-09-03T22:00:00.000Z",
    });
  });

  it("grounds a clock from an explicit morning qualifier", () => {
    const source = "We’ll combine everything Friday morning at 9:30.";
    const result = compile(source, [
      responsibility({
        id: "combine-notes",
        title: "Combine research notes",
        kind: "event",
        sourceText: source,
        occurrence: {
          date: "2026-09-04",
          startTime: "09:30",
          endTime: "10:30",
          confidence: 0.98,
        },
      }),
    ]);

    expect(result.tasks[0]).toMatchObject({
      fixedStartAt: "2026-09-04T16:30:00.000Z",
      fixedEndAt: "2026-09-04T17:15:00.000Z",
    });
  });

  it("grounds both clocks when a range shares its PM suffix", () => {
    const source = "I also have class from 1–3 PM.";
    const result = compile(source, [
      responsibility({
        id: "class",
        title: "Class",
        kind: "event",
        sourceText: source,
        occurrence: {
          date: "2026-09-03",
          startTime: "13:00",
          endTime: "15:00",
          confidence: 0.98,
        },
      }),
    ]);

    expect(result.tasks[0]).toMatchObject({
      fixedStartAt: "2026-09-03T20:00:00.000Z",
      fixedEndAt: "2026-09-03T22:00:00.000Z",
    });
  });

  it("schedules a start-only fixed event with a clearly inferred reservation", () => {
    const source = "The project meeting happens Thursday at 2 PM.";
    const result = compile(source, [
      responsibility({
        id: "project-meeting",
        title: "Project meeting",
        kind: "event",
        sourceText: source,
        occurrence: {
          date: "2026-09-03",
          startTime: "14:00",
          confidence: 0.98,
        },
        missingInformation: ["Exact event end time is not specified."],
        reviewRequired: true,
      }),
    ]);
    const meeting = result.tasks[0];

    expect(meeting).toMatchObject({
      taskType: "fixed_time",
      responsibilityKind: "event",
      fixedStartAt: "2026-09-03T21:00:00.000Z",
      fixedEndAt: "2026-09-03T21:45:00.000Z",
      estimatedMinutes: 45,
      effortEstimateSource: "ai",
      reviewRequired: false,
      approved: true,
      missingInformation: [],
    });
    expect(meeting.fieldProvenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "fixedStartAt",
          origin: "explicit",
        }),
        expect.objectContaining({
          path: "estimatedMinutes",
          origin: "inferred",
          rationale: expect.stringMatching(/45-minute block/i),
        }),
        expect.objectContaining({
          path: "fixedEndAt",
          origin: "inferred",
          rationale: expect.stringMatching(/45-minute block/i),
        }),
      ]),
    );
    expect(
      meeting.fieldProvenance?.find((field) => field.path === "fixedEndAt")
        ?.evidence,
    ).toBeUndefined();

    const proposal = generateSchedule({
      windowStart: "2026-09-03T07:00:00.000Z",
      windowEnd: "2026-09-04T07:00:00.000Z",
      tasks: result.tasks,
      preferences: {
        ...TEST_PREFERENCES,
        timeZone: "America/Los_Angeles",
      },
      availability: [
        {
          start: "2026-09-03T20:00:00.000Z",
          end: "2026-09-03T23:00:00.000Z",
        },
      ],
      unavailableEvents: [],
      blockedTimes: [],
      lockedSessions: [],
    });

    expect(proposal.unschedulable).toEqual([]);
    expect(proposal.sessions).toEqual([
      expect.objectContaining({
        taskId: "project-meeting",
        start: "2026-09-03T21:00:00.000Z",
        end: "2026-09-03T21:45:00.000Z",
        minutes: 45,
        locked: true,
      }),
    ]);
  });

  it("projects hard deadlines as due fields and soft deadlines as preferences", () => {
    const hard = "Submit the lab memo Friday at 5:30 PM.";
    const soft = "Try to finish the figures Saturday morning.";
    const result = compile(`${hard}\n${soft}`, [
      responsibility({
        id: "lab-memo",
        title: "Submit lab memo",
        kind: "task",
        sourceText: hard,
        deadline: {
          date: "2026-09-04",
          time: "17:30",
          strength: "hard",
          confidence: 0.98,
        },
      }),
      responsibility({
        id: "figures",
        title: "Finish figures",
        kind: "task",
        sourceText: soft,
        deadline: {
          date: "2026-09-05",
          period: "Saturday morning",
          strength: "soft",
          confidence: 0.88,
        },
      }),
    ]);

    const hardTask = result.tasks.find((task) => task.id === "lab-memo");
    const softTask = result.tasks.find((task) => task.id === "figures");
    expect(hardTask).toMatchObject({
      deadlineStrength: "hard",
      dueDate: "2026-09-04",
      dueTime: "17:30",
      dueAt: "2026-09-05T00:30:00.000Z",
    });
    expect(softTask).toMatchObject({ deadlineStrength: "soft" });
    expect(softTask?.dueDate).toBeUndefined();
    expect(softTask?.dueTime).toBeUndefined();
    expect(softTask?.dueAt).toBeUndefined();
    expect(softTask?.schedulingConstraints?.preferredDateWindows).toEqual([
      {
        start: "2026-09-05T16:00:00.000Z",
        end: "2026-09-05T19:00:00.000Z",
        label: "Saturday morning",
        precision: "named_period",
      },
    ]);
  });

  it("merges an anaphoric deadline into its next-week task and deduplicates its preferred window", () => {
    const plan = "I should probably work on the essay early next week.";
    const deadline = "It’s due Thursday.";
    const result = compile(`${plan} ${deadline}`, [
      responsibility({
        id: "essay",
        title: "Complete essay",
        kind: "task",
        sourceText: plan,
        deadline: {
          date: "2026-09-07",
          period: "early next week",
          strength: "soft",
          confidence: 0.72,
        },
        constraints: {
          preferredWindows: [
            {
              date: "2026-09-07",
              period: "early next week",
              label: "early next week",
            },
          ],
        },
      }),
      responsibility({
        id: "essay-deadline",
        title: "Essay deadline",
        kind: "task",
        sourceText: deadline,
        deadline: {
          // Deliberately nearest-Thursday output: paragraph scope must repair it.
          date: "2026-09-03",
          strength: "hard",
          confidence: 0.82,
        },
      }),
    ]);

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      id: "essay",
      dueDate: "2026-09-10",
      deadlineStrength: "hard",
    });
    expect(
      result.tasks[0].schedulingConstraints?.preferredDateWindows,
    ).toEqual([
      expect.objectContaining({
        start: "2026-09-07T16:00:00.000Z",
        end: "2026-09-08T00:00:00.000Z",
        label: "early next week",
      }),
    ]);
  });

  it("recovers an explicit early-next-week preference when AI omitted it", () => {
    const plan = "I should probably work on the essay early next week.";
    const deadline = "It’s due Thursday.";
    const result = compile(`${plan} ${deadline}`, [
      responsibility({
        id: "essay",
        title: "Complete essay",
        kind: "task",
        sourceText: plan,
      }),
      responsibility({
        id: "essay-deadline",
        title: "Essay deadline",
        kind: "task",
        sourceText: deadline,
        deadline: {
          date: "2026-09-03",
          strength: "hard",
          confidence: 0.82,
        },
      }),
    ]);

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      dueDate: "2026-09-10",
      deadlineStrength: "hard",
    });
    expect(
      result.tasks[0].schedulingConstraints?.preferredDateWindows,
    ).toContainEqual(
      expect.objectContaining({
        start: "2026-09-07T16:00:00.000Z",
        label: "early next week",
      }),
    );
  });

  it("overrides an existing misresolved AI window with the source-relative preference", () => {
    const plan = "I should probably work on the essay early next week.";
    const deadline = "It’s due sometime Thursday, I think.";
    const result = compile(`${plan} ${deadline}`, [
      responsibility({
        id: "essay",
        title: "Complete essay",
        kind: "task",
        sourceText: plan,
        constraints: {
          preferredWindows: [
            {
              // Reproduce the live variance: Gemini copied Thursday's date
              // onto a separately stated early-next-week preference.
              date: "2026-09-10",
              startTime: "09:00",
              endTime: "17:00",
              period: "early next week",
              label: "early next week",
            },
          ],
        },
      }),
      responsibility({
        id: "essay-deadline",
        title: "Essay deadline",
        kind: "task",
        sourceText: deadline,
        deadline: {
          date: "2026-09-03",
          period: "sometime Thursday",
          strength: "hard",
          confidence: 0.62,
        },
        missingInformation: ["Confirm the exact essay deadline time"],
        reviewRequired: true,
      }),
    ]);

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      dueDate: "2026-09-10",
      deadlineStrength: "hard",
    });
    expect(
      result.tasks[0].schedulingConstraints?.preferredDateWindows,
    ).toEqual([
      expect.objectContaining({
        start: "2026-09-07T16:00:00.000Z",
        end: "2026-09-08T00:00:00.000Z",
        label: "early next week",
        precision: "named_period",
      }),
    ]);
  });

  it("does not cross-attach a recovered soft preference across broad overlapping source spans", () => {
    const source =
      "I should probably work on the essay early next week. I also need to call the dentist.";
    const result = compile(source, [
      responsibility({
        id: "essay",
        title: "Complete essay",
        kind: "task",
        // Discovery spans are allowed to overlap and can occasionally retain
        // a whole paragraph for more than one responsibility.
        sourceText: source,
      }),
      responsibility({
        id: "dentist",
        title: "Call dentist",
        kind: "task",
        sourceText: source,
      }),
    ]);

    const essay = result.tasks.find((task) => task.id === "essay");
    const dentist = result.tasks.find((task) => task.id === "dentist");
    expect(
      essay?.schedulingConstraints?.preferredDateWindows,
    ).toContainEqual(
      expect.objectContaining({
        start: "2026-09-07T16:00:00.000Z",
        label: "early next week",
      }),
    );
    expect(
      dentist?.schedulingConstraints?.preferredDateWindows,
    ).toBeUndefined();
  });

  it("retargets each next-week weekday fact without collapsing distinct dates", () => {
    const source =
      "Next week, outline Monday morning, then submit the draft Thursday.";
    const result = compile(source, [
      responsibility({
        id: "draft",
        title: "Complete draft",
        kind: "task",
        sourceText: source,
        deadline: {
          // Deliberately current-week dates: scope repair must move each fact
          // to its own named weekday next week.
          date: "2026-09-03",
          strength: "hard",
          confidence: 0.88,
        },
        constraints: {
          preferredWindows: [
            {
              date: "2026-08-31",
              period: "Monday morning",
              label: "Monday morning",
            },
          ],
        },
      }),
    ]);

    expect(result.tasks[0]).toMatchObject({ dueDate: "2026-09-10" });
    expect(
      result.tasks[0].schedulingConstraints?.preferredDateWindows,
    ).toEqual([
      expect.objectContaining({
        start: "2026-09-07T16:00:00.000Z",
        end: "2026-09-07T19:00:00.000Z",
        label: "Monday morning",
      }),
    ]);
  });

  it("propagates a shared Saturday heading to each undated child task", () => {
    const chemistry = "Study chemistry for at least 90 minutes";
    const call = "Call Alex after 3 PM";
    const source = `On Saturday I want to:\n- ${chemistry}\n- ${call}`;
    const result = compile(source, [
      responsibility({
        id: "chemistry",
        title: "Study chemistry",
        kind: "task",
        sourceText: chemistry,
        duration: { minimumMinutes: 90, explicit: true },
      }),
      responsibility({
        id: "call-alex",
        title: "Call Alex",
        kind: "task",
        sourceText: call,
        constraints: {
          earliestStart: { time: "15:00", label: "after 3 PM" },
        },
      }),
    ]);

    const chemistryTask = result.tasks.find((task) => task.id === "chemistry");
    const callTask = result.tasks.find((task) => task.id === "call-alex");
    expect(
      chemistryTask?.schedulingConstraints?.allowedDateWindows,
    ).toContainEqual(
      expect.objectContaining({
        start: "2026-09-05T07:00:00.000Z",
        label: "Saturday context",
      }),
    );
    expect(callTask?.schedulingConstraints?.allowedDateWindows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          start: "2026-09-05T22:00:00.000Z",
          label: "after 3 PM",
        }),
      ]),
    );
  });

  it("propagates a bare weekday heading with a parenthetical day marker", () => {
    const email = "6:00 PM — Email Professor Anderson";
    const gym = "7:30 PM — Gym";
    const source = `Monday (today)\n${email}\n${gym}`;
    const result = compile(source, [
      responsibility({
        id: "email-professor",
        title: "Email Professor Anderson",
        kind: "task",
        sourceText: email,
        constraints: {
          allowedWindows: [
            { startTime: "18:00", endTime: "18:01", label: "6:00 PM" },
          ],
        },
      }),
      responsibility({
        id: "gym",
        title: "Gym",
        kind: "task",
        sourceText: gym,
        constraints: {
          allowedWindows: [
            { startTime: "19:30", endTime: "19:31", label: "7:30 PM" },
          ],
        },
      }),
    ]);

    expect(
      result.tasks[0].schedulingConstraints?.allowedDateWindows,
    ).toContainEqual(
      expect.objectContaining({
        start: "2026-09-08T01:00:00.000Z",
        label: "6:00 PM",
      }),
    );
    expect(
      result.tasks[1].schedulingConstraints?.allowedDateWindows,
    ).toContainEqual(
      expect.objectContaining({
        start: "2026-09-08T02:30:00.000Z",
        label: "7:30 PM",
      }),
    );
  });

  it("keeps a named-period event as an occurrence window without inventing an exact time", () => {
    const source = "The advisory meeting is Thursday afternoon.";
    const result = compile(source, [
      responsibility({
        id: "advisory-meeting",
        title: "Advisory meeting",
        kind: "event",
        sourceText: source,
        occurrence: {
          date: "2026-09-03",
          period: "Thursday afternoon",
          confidence: 0.86,
        },
      }),
    ]);

    expect(result.tasks[0]).toMatchObject({
      taskType: "flexible",
      occurrenceWindow: {
        start: "2026-09-03T19:00:00.000Z",
        end: "2026-09-04T00:00:00.000Z",
        label: "Thursday afternoon",
        precision: "named_period",
      },
      reviewRequired: true,
      approved: false,
    });
    expect(result.tasks[0].fixedStartAt).toBeUndefined();
    expect(result.tasks[0].fixedEndAt).toBeUndefined();
  });

  it("does not persist a soft numeric relationship as a link when no anchor exists", () => {
    const chemistry = "Study chemistry for 90 minutes.";
    const coding =
      "Leave 30 minutes after chemistry before coding, if possible.";
    const result = compile(`${chemistry} ${coding}`, [
      responsibility({
        id: "chemistry",
        title: "Study chemistry",
        kind: "task",
        sourceText: chemistry,
      }),
      responsibility({
        id: "coding",
        title: "Work on coding assignment",
        kind: "task",
        sourceText: coding,
      }),
    ], [
      {
        fromId: "coding",
        toId: "chemistry",
        relation: "after",
        strength: "soft",
        minimumGapMinutes: 30,
        reason: "The user prefers a meal break between chemistry and coding.",
        sourceText: coding,
      },
    ]);

    const task = result.tasks.find((task) => task.id === "coding");
    expect(task?.dependencies).toBeUndefined();
    expect(task?.schedulingConstraints?.calculatedTiming).toBeDefined();
    expect(task?.missingInformation.join(" ")).toContain("anchor date/time");
  });

  it("derives an order-by deadline from lead time before a dated milestone", () => {
    const order = "Order the bearings four days before they must arrive.";
    const arrival = "The bearings must arrive Wednesday at noon.";
    const result = compile(`${order} ${arrival}`, [
      responsibility({
        id: "order-bearings",
        title: "Order bearings",
        kind: "task",
        sourceText: order,
      }),
      responsibility({
        id: "bearing-arrival",
        title: "Bearings arrive",
        kind: "milestone",
        sourceText: arrival,
        deadline: {
          date: "2026-09-09",
          time: "12:00",
          strength: "hard",
          confidence: 0.98,
        },
      }),
    ], [
      {
        fromId: "order-bearings",
        toId: "bearing-arrival",
        relation: "before",
        strength: "hard",
        minimumGapMinutes: 4 * 24 * 60,
        reason: "Shipping requires four days.",
        sourceText: order,
      },
    ]);

    const orderTask = result.tasks.find((task) => task.id === "order-bearings");
    expect(orderTask).toMatchObject({
      deadlineStrength: "hard",
      dueDate: "2026-09-05",
      dueTime: "12:00",
      dueAt: "2026-09-05T19:00:00.000Z",
    });
    expect(orderTask?.fieldProvenance).toContainEqual(
      expect.objectContaining({ path: "dueAt", origin: "derived" }),
    );
  });

  it("does not invent numeric relationships when the AI supplied only identities", () => {
    const source =
      "Order the bearings once the shaft diameter is finalized. Shipping takes 3–4 days, and we need the bearings by next Wednesday.";
    const result = compile(source, [
      responsibility({
        id: "shaft",
        title: "Finalize shaft diameter",
        kind: "task",
        sourceText: "the shaft diameter is finalized",
      }),
      responsibility({
        id: "order",
        title: "Order bearings",
        kind: "task",
        sourceText: "Order the bearings once the shaft diameter is finalized.",
        deadline: {
          date: "2026-09-02",
          strength: "hard",
          confidence: 0.7,
        },
      }),
      responsibility({
        id: "arrival",
        title: "Bearings delivery",
        kind: "milestone",
        sourceText: "we need the bearings by next Wednesday",
      }),
    ]);

    const order = result.tasks.find((task) => task.id === "order");
    expect(order?.dependencies).toBeUndefined();
    expect(order?.schedulingConstraints?.calculatedTiming).toBeUndefined();
    expect(result.tasks.find((task) => task.id === "shaft")?.dependencies).toBeUndefined();
  });

  it("compiles weekday recurrence without exact times as a scheduling quota", () => {
    const source =
      "Starting next week, review calculus every Monday, Wednesday, and Friday.";
    const result = compile(source, [
      responsibility({
        id: "calculus-review",
        title: "Review calculus",
        kind: "task",
        sourceText: source,
        recurrence: {
          frequency: "weekly",
          interval: 1,
          daysOfWeek: ["monday", "wednesday", "friday"],
          startDate: "2026-09-07",
        },
      }),
    ]);

    expect(result.tasks[0]).toMatchObject({
      taskType: "recurring_goal",
      recurrence: {
        frequency: "weekly",
        mode: "quota",
        interval: 1,
        anchorDate: "2026-09-07",
        count: 3,
        daysOfWeek: ["monday", "wednesday", "friday"],
        windowStart: "2026-09-07T07:00:00.000Z",
      },
    });
    expect(result.tasks[0].recurrence?.timeRules).toBeUndefined();
  });

  it("uses the nominal midpoint for an approximate duration range", () => {
    const source = "We’ll meet Thursday at 2 PM for about an hour.";
    const result = compile(source, [
      responsibility({
        id: "meeting",
        title: "Meeting",
        kind: "event",
        sourceText: source,
        occurrence: {
          date: "2026-09-03",
          startTime: "14:00",
          confidence: 0.96,
        },
        duration: {
          minimumMinutes: 50,
          maximumMinutes: 70,
          explicit: true,
        },
      }),
    ]);

    expect(result.tasks[0]).toMatchObject({
      estimatedMinutes: 60,
      fixedStartAt: "2026-09-03T21:00:00.000Z",
    });
  });

  it("removes an unsupported exact deadline clock instead of retaining false precision", () => {
    const source = "The essay is due sometime Thursday.";
    const result = compile(source, [
      responsibility({
        id: "essay",
        title: "Complete essay",
        kind: "task",
        sourceText: source,
        deadline: {
          date: "2026-09-03",
          time: "23:59",
          strength: "hard",
          confidence: 0.7,
        },
      }),
    ]);

    expect(result.tasks[0]).toMatchObject({
      dueDate: "2026-09-03",
      reviewRequired: true,
      approved: false,
    });
    expect(result.tasks[0].dueTime).toBeUndefined();
    expect(result.tasks[0].dueAt).toBeUndefined();
    expect(result.tasks[0].fieldConfidence.dueTime).toBeUndefined();
    expect(result.tasks[0].missingInformation).toContain(
      "Confirm the exact deadline time; no supporting clock appears in the source.",
    );
  });

  it("keeps a clock supported by a source-grounded constraint label", () => {
    const identity = "Tomorrow I need to work on physics.";
    const detail = "The homework is due at 10 PM.";
    const result = compile(`${identity} ${detail}`, [
      responsibility({
        id: "physics",
        title: "Work on physics",
        kind: "task",
        sourceText: identity,
        deadline: {
          date: "2026-09-03",
          time: "22:00",
          strength: "hard",
          confidence: 0.98,
        },
        constraints: {
          latestEnd: {
            date: "2026-09-03",
            time: "22:00",
            label: "homework is due at 10 PM",
          },
        },
      }),
    ]);

    expect(result.tasks[0]).toMatchObject({
      dueTime: "22:00",
      dueAt: "2026-09-04T05:00:00.000Z",
      reviewRequired: false,
    });
  });

  it("resolves a bare weekday after this weekend into the following week", () => {
    const weekend = "Get the report mostly finished this weekend.";
    const monday = "I want to review it Monday morning.";
    const result = compile(`${weekend} ${monday}`, [
      responsibility({
        id: "report",
        title: "Get report mostly finished",
        kind: "task",
        sourceText: weekend,
        deadline: {
          date: "2026-09-06",
          period: "this weekend",
          strength: "soft",
          confidence: 0.9,
        },
      }),
      responsibility({
        id: "review",
        title: "Review report",
        kind: "task",
        sourceText: monday,
        constraints: {
          allowedWindows: [
            { date: "2026-08-31", period: "morning", label: "morning" },
          ],
        },
      }),
    ]);

    expect(
      result.tasks.find((task) => task.id === "review")?.schedulingConstraints
        ?.allowedDateWindows,
    ).toEqual([
      expect.objectContaining({
        start: "2026-09-07T16:00:00.000Z",
        end: "2026-09-07T19:00:00.000Z",
      }),
    ]);
  });

  it("derives a recurrence anchor from an explicit starting-next-week phrase", () => {
    const source = "Starting next week, practice every Monday and Friday.";
    const result = compile(source, [
      responsibility({
        id: "practice",
        title: "Practice",
        kind: "task",
        sourceText: source,
        recurrence: {
          frequency: "weekly",
          daysOfWeek: ["monday", "friday"],
        },
      }),
    ]);

    expect(result.tasks[0].recurrence).toMatchObject({
      anchorDate: "2026-09-07",
      windowStart: "2026-09-07T07:00:00.000Z",
    });
  });

  it("normalizes a task deadline at midnight to the end of its due day", () => {
    const source = "The lab is due Thursday at midnight.";
    const result = compile(source, [
      responsibility({
        id: "lab",
        title: "Finish lab",
        kind: "task",
        sourceText: source,
        deadline: {
          date: "2026-09-03",
          time: "00:00",
          strength: "hard",
          confidence: 0.98,
        },
      }),
    ]);

    expect(result.tasks[0]).toMatchObject({
      dueDate: "2026-09-03",
      dueTime: "23:59",
      dueAt: "2026-09-04T06:59:00.000Z",
    });
  });

  it("corrects an AI deadline clock from an explicit PM source clock", () => {
    const source = "The homework is due at 3 PM.";
    const result = compile(source, [
      responsibility({
        id: "homework",
        title: "Finish homework",
        kind: "task",
        sourceText: source,
        deadline: {
          date: "2026-09-04",
          time: "03:00",
          strength: "hard",
          confidence: 0.95,
        },
      }),
    ]);

    expect(result.tasks[0]).toMatchObject({
      dueDate: "2026-09-04",
      dueTime: "15:00",
      dueAt: "2026-09-04T22:00:00.000Z",
    });
  });

  it("uses the stated work duration instead of a submission-click estimate", () => {
    const source =
      "I need to submit my math homework. The homework should take about 90 minutes to finish.";
    const result = compile(source, [
      responsibility({
        id: "homework",
        title: "Submit math homework",
        kind: "task",
        sourceText: source,
        duration: {
          minimumMinutes: 1,
          preferredMinutes: 1,
          maximumMinutes: 1,
          explicit: false,
        },
        planning: { estimatedMinutes: 1 },
      }),
    ]);

    expect(result.tasks[0]).toMatchObject({
      estimatedMinutes: 90,
      effortEstimateSource: "stated",
      durationRange: {
        minimumMinutes: 90,
        preferredMinutes: 90,
        maximumMinutes: 90,
      },
    });
  });

  it("drops an impossible past AI-estimated placement", () => {
    const source = "Study biology this week before the exam next Monday.";
    const result = compile(source, [
      responsibility({
        id: "biology",
        title: "Study biology",
        kind: "task",
        sourceText: source,
        deadline: {
          date: "2026-09-07",
          time: "09:00",
          strength: "hard",
          confidence: 0.95,
        },
        constraints: {
          preferredWindows: [
            {
              date: "2026-02-09",
              startTime: "00:00",
              endTime: "09:00",
              label: "AI estimated placement",
            },
          ],
        },
      }),
    ]);

    expect(
      result.tasks[0].schedulingConstraints?.preferredDateWindows,
    ).toBeUndefined();
  });

  it("preserves a task-specific do-not-work-tonight restriction", () => {
    const source =
      "The first draft is due Friday. It will take two hours, but I don't want to work on it tonight.";
    const result = compile(source, [
      responsibility({
        id: "draft",
        title: "Finish first draft",
        kind: "task",
        sourceText: source,
        deadline: {
          date: "2026-09-04",
          strength: "hard",
          confidence: 0.95,
        },
        duration: { preferredMinutes: 120, explicit: true },
      }),
    ]);

    expect(
      result.tasks[0].schedulingConstraints?.allowedDateWindows,
    ).toContainEqual({
      start: "2026-09-03T07:00:00.000Z",
      end: "2026-09-05T06:59:00.000Z",
      label: "Do not work on this tonight",
      precision: "exact",
    });
  });

  it("does not turn a recurring allowed window into an exact recurrence", () => {
    const source =
      "Every Tuesday and Thursday, practice sometime between 4 PM and 8 PM.";
    const result = compile(source, [
      responsibility({
        id: "practice",
        title: "Practice",
        kind: "task",
        sourceText: source,
        constraints: {
          allowedWindows: [
            { startTime: "16:00", endTime: "20:00", label: "4 PM to 8 PM" },
          ],
        },
        recurrence: {
          frequency: "weekly",
          daysOfWeek: ["tuesday", "thursday"],
          exactTimes: [
            {
              daysOfWeek: ["tuesday", "thursday"],
              time: "16:00",
            },
          ],
        },
      }),
    ]);

    expect(result.tasks[0].recurrence).toMatchObject({
      mode: "quota",
      count: 2,
      daysOfWeek: ["tuesday", "thursday"],
    });
    expect(result.tasks[0].recurrence?.timeRules).toBeUndefined();
  });

  it("preserves an explicit move-earlier recurring exception", () => {
    const source =
      "Every Tuesday and Thursday, practice Spanish. But next Thursday I have a concert, so move that session earlier in the day instead of skipping it.";
    const result = compile(source, [
      responsibility({
        id: "spanish",
        title: "Practice Spanish",
        kind: "task",
        sourceText: "Every Tuesday and Thursday, practice Spanish.",
        recurrence: {
          frequency: "weekly",
          daysOfWeek: ["tuesday", "thursday"],
        },
      }),
      responsibility({
        id: "concert",
        title: "Concert",
        kind: "event",
        sourceText: "next Thursday I have a concert",
        occurrence: {
          date: "2026-09-10",
          startTime: "17:00",
          endTime: "22:00",
          confidence: 0.95,
        },
      }),
    ]);

    expect(result.tasks.find((task) => task.id === "spanish")?.conditionalRules).toEqual([
      expect.objectContaining({
        effect: "move that session earlier in the day instead of skipping it",
        requiresReview: false,
      }),
    ]);
  });

  it("restores all explicitly listed recurring weekdays", () => {
    const source =
      "Every Tuesday and Thursday, schedule 30 minutes for Spanish practice.";
    const result = compile(source, [
      responsibility({
        id: "spanish",
        title: "Spanish practice",
        kind: "task",
        sourceText: source,
        recurrence: {
          frequency: "weekly",
          daysOfWeek: ["tuesday"],
        },
      }),
    ]);

    expect(result.tasks[0].recurrence).toMatchObject({
      daysOfWeek: ["tuesday", "thursday"],
      count: 2,
    });
  });

  it("grounds an AI date for an explicit next weekday to the source phrase", () => {
    const source = "The exam is next Monday at 9 AM.";
    const result = compile(source, [
      responsibility({
        id: "exam",
        title: "Exam",
        kind: "event",
        sourceText: source,
        occurrence: {
          date: "2026-09-14",
          startTime: "09:00",
          endTime: "10:00",
          confidence: 0.98,
        },
      }),
    ]);

    expect(result.tasks[0]).toMatchObject({
      fixedStartAt: "2026-09-07T16:00:00.000Z",
      fixedEndAt: "2026-09-07T16:45:00.000Z",
    });
  });

  it("preserves an earlier preference from a dialogue confirmation", () => {
    const slides = "Send the slides Wednesday at midnight.";
    const confirmation = "Professor: Yes, but preferably earlier.";
    const result = compile(`${slides} ${confirmation}`, [
      responsibility({
        id: "slides",
        title: "Send slides",
        kind: "task",
        sourceText: slides,
        deadline: {
          date: "2026-09-02",
          time: "23:59",
          strength: "hard",
          confidence: 0.98,
        },
      }),
    ]);

    expect(
      result.tasks[0].schedulingConstraints?.preferredDateWindows,
    ).toContainEqual(
      expect.objectContaining({ label: "Preferably earlier" }),
    );
  });

  it("recovers a source-explicit duration range linked to one responsibility", () => {
    const action = "Finish the coding assignment.";
    const detail = "Coding will probably take 2–3 hours.";
    const result = compile(`${action}\n${detail}`, [
      responsibility({
        id: "coding",
        title: "Finish coding assignment",
        kind: "task",
        sourceText: action,
        duration: { minimumMinutes: 45, explicit: false },
      }),
    ]);

    expect(result.tasks[0]).toMatchObject({
      estimatedMinutes: 180,
      effortEstimateSource: "stated",
      durationRange: {
        minimumMinutes: 120,
        maximumMinutes: 180,
      },
    });
  });

  it("attaches an actual-submission continuation to the deliverable, not its review", () => {
    const draft = "Get the report mostly finished this weekend.";
    const review = "I want to review it Monday morning.";
    const submission =
      "The actual submission isn’t until next Wednesday at midnight.";
    const result = compile(`${draft} ${review} ${submission}`, [
      responsibility({
        id: "report",
        title: "Finish report",
        kind: "task",
        sourceText: draft,
        deadline: {
          date: "2026-09-06",
          period: "this weekend",
          strength: "soft",
          confidence: 0.9,
        },
      }),
      responsibility({
        id: "review",
        title: "Review report",
        kind: "task",
        sourceText: review,
        constraints: {
          allowedWindows: [
            { date: "2026-08-31", period: "morning", label: "morning" },
          ],
        },
      }),
    ]);

    expect(result.tasks.find((task) => task.id === "report")).toMatchObject({
      dueDate: "2026-09-09",
      dueTime: "23:59",
      deadlineStrength: "hard",
    });
    expect(result.tasks.find((task) => task.id === "review")?.dueDate).toBeUndefined();
  });

  it("recovers a named completion date from an unambiguous later clause", () => {
    const action = "Finish the motor calculations before starting CAD.";
    const deadline = "I’d like the calculations done by Tuesday.";
    const result = compile(`${action} ${deadline}`, [
      responsibility({
        id: "motor",
        title: "Finish motor calculations",
        kind: "task",
        sourceText: action,
      }),
      responsibility({
        id: "cad",
        title: "Start CAD",
        kind: "task",
        sourceText: action,
      }),
    ]);

    expect(result.tasks.find((task) => task.id === "motor")).toMatchObject({
      dueDate: "2026-09-08",
      deadlineStrength: "hard",
    });
    expect(result.tasks.find((task) => task.id === "cad")?.dueDate).toBeUndefined();
  });
});
