import { describe, expect, it } from "vitest";
import { formatInTimeZone } from "date-fns-tz";
import { compileSemanticDraft } from "../lib/providers/semantic-draft-compiler";
import { semanticDraftSchema, type SemanticDraft } from "../lib/providers/semantic-draft";
import { checkQuotedTiming } from "../lib/providers/quoted-timing";
import { validateAndDedupeExtraction } from "../lib/domain/extraction-schema";
import { generateSchedule } from "../lib/domain/scheduler";
import { reconcileHybridExtraction } from "../lib/providers/hybrid-reconciliation";
import { finalizeStagedExtraction } from "../lib/providers/staged-extraction";
import { TEST_PREFERENCES } from "./fixtures";

const input = { currentLocalDate: "2026-09-05", timeZone: "America/Los_Angeles", sourceId: "quoted-timing-test" };
const clock = (value?: string) => value ? formatInTimeZone(value, input.timeZone, "yyyy-MM-dd HH:mm") : undefined;
function fixture(text = "dentis apointment at 3 pm on monday, and arrive 30 minutes before") {
  const draft: SemanticDraft = {
    responsibilities: [
      { id: "dentist", title: "Dentist appointment", kind: "event", sourceText: text.split(/[,\.]/)[0], occurrence: { date: "2026-09-07", startTime: "15:00", endTime: "16:00", confidence: 1 }, duration: { preferredMinutes: 60, explicit: false }, confidence: 1, missingInformation: [], reviewRequired: false },
      { id: "arrival", title: "Arrive at dentist", kind: "milestone", sourceText: text, occurrence: { date: "2026-09-08", startTime: "14:00", confidence: 1 }, confidence: 1, missingInformation: [], reviewRequired: false },
    ],
    relations: [{ fromId: "arrival", toId: "dentist", relation: "before", strength: "hard", minimumGapMinutes: 30, timing: "arrival_buffer", fromBoundary: "start", toBoundary: "start", mode: "exact", approximate: false, sourceText: text, fromText: "arrive", reason: "Arrival is half an hour before the appointment." }],
    blockedTimes: [], globalInstructions: [], ignoredStatements: [],
  };
  return { text, draft };
}
function compile(test = fixture()) {
  return validateAndDedupeExtraction(compileSemanticDraft({ ...input, text: test.text }, semanticDraftSchema.parse(test.draft)));
}
function schedule(tasks: ReturnType<typeof compile>["tasks"]) {
  return generateSchedule({ tasks, windowStart: "2026-09-07T07:00:00Z", windowEnd: "2026-09-08T07:00:00Z", preferences: { ...TEST_PREFERENCES, timeZone: input.timeZone }, availability: [{ start: "2026-09-07T14:00:00Z", end: "2026-09-08T05:00:00Z" }], unavailableEvents: [], blockedTimes: [], lockedSessions: [] });
}

describe("quoted AI relationships and review-only calculations", () => {
  it("calculates independently of an abbreviated relationship quote", () => {
    const test = fixture("Dentist appointment at 3 PM on Monday. There will be paperwork at reception. Arrive 30 minutes before.");
    test.draft.relations[0].sourceText = "Dentist appointment at 3 PM on Monday. ... Arrive 30 minutes before.";
    const arrival = compile(test).tasks[1];
    expect(clock(arrival.fixedStartAt)).toBe("2026-09-07 14:30");
    expect(arrival.dependencies).toBeUndefined();
    expect(arrival.reviewRequired).toBe(true);
  });

  it("does not gate special arithmetic on paraphrased or ambiguous quotes", () => {
    const test = fixture("Dentist appointment at 3 PM on Monday. Arrive 30 minutes before. Arrive 30 minutes before.");
    test.draft.relations[0].sourceText = "Dentist appointment at 3 PM on Monday. ... Arrive 30 minutes before.";
    expect(clock(compile(test).tasks[1].fixedStartAt)).toBe("2026-09-07 14:30");
    test.draft.relations[0].sourceText = "Dentist appointment at 3 PM on Monday. ... Get there 30 minutes early.";
    expect(clock(compile(test).tasks[1].fixedStartAt)).toBe("2026-09-07 14:30");
  });
  it.each([
    "dentis apointment at 3 pm on monday, and arrive 30 minutes before",
    "Dentist appointment at 3 PM on Monday, and arrive 30 minutes before.",
    "Dentist appointment at 3 PM on Monday. Arrive half an hour beforehand.",
    "Dentist appointment at 3 PM on Monday; get there half an hour ahead of time.",
    "Dentist appointment at 3 PM on Monday — be there thirty minutes ahead of that.",
  ])("keeps the calculated date/time for ordinary wording: %s", (text) => {
    const result = compile(fixture(text));
    expect(clock(result.tasks[0].fixedStartAt)).toBe("2026-09-07 15:00");
    const arrival = result.tasks[1];
    expect(clock(arrival.fixedStartAt)).toBe("2026-09-07 14:30");
    expect(arrival).toMatchObject({ taskType: "fixed_time", fixedStartAt: "2026-09-07T21:30:00.000Z", fixedEndAt: "2026-09-07T22:00:00.000Z", reviewRequired: true, approved: false });
    expect(arrival.estimatedMinutes).toBe(30);
    expect(arrival.fieldProvenance?.some((field) => field.path.startsWith("relationships."))).toBe(false);
    expect(arrival.schedulingConstraints?.calculatedTiming).toBeDefined();
    expect(arrival.fieldProvenance).toContainEqual(expect.objectContaining({ path: "fixedStartAt", origin: "derived" }));
  });

  it("does not mistake quote presence for correct meaning", () => {
    const test = fixture("Dentist appointment at 3 PM on Monday. Do not arrive early.");
    const result = compile(test);
    // A deliberately wrong AI interpretation is only a proposal, never auto-approved.
    expect(clock(result.tasks[1].fixedStartAt)).toBe("2026-09-07 14:30");
    expect(result.tasks[1].reviewRequired).toBe(true);
    expect(schedule(result.tasks).sessions.map((session) => session.taskId)).toEqual(["arrival", "dentist"]);
  });

  it("uses normalized AI minutes, not an independent language parser", () => {
    const test = fixture();
    test.draft.relations[0].minimumGapMinutes = 25;
    expect(clock(compile(test).tasks[1].fixedStartAt)).toBe("2026-09-07 14:35");
    expect(compile(test).tasks[1].reviewRequired).toBe(true);
  });

  it.each(["missing quote", "fabricated quote", "missing reference", "self-reference"])("uses available operands, not quote validation: %s", (problem) => {
    const test = fixture();
    if (problem === "missing quote") delete test.draft.relations[0].sourceText;
    if (problem === "fabricated quote") test.draft.relations[0].sourceText = "Arrive at two thirty.";
    if (problem === "missing reference") test.draft.relations[0].toId = "missing";
    if (problem === "self-reference") test.draft.relations[0].toId = "arrival";
    const result = compile(test);
    if (problem.endsWith("quote")) expect(clock(result.tasks[1].fixedStartAt)).toBe("2026-09-07 14:30");
    else expect(result.tasks[1].fixedStartAt).toBeUndefined();
    expect(result.tasks[1].reviewRequired).toBe(true);
    expect(clock(result.tasks[0].fixedStartAt)).toBe("2026-09-07 15:00");
  });

  it.each([-1, Infinity, 1.5, 100000])("rejects invalid offset %s", (minimumGapMinutes) => {
    const { text, draft } = fixture();
    expect(checkQuotedTiming({ ...input, text }, { ...draft.relations[0], minimumGapMinutes }, draft.responsibilities[1], draft.responsibilities[0])).toBeUndefined();
  });

  it("rejects impossible calendar dates", () => {
    const test = fixture();
    test.draft.responsibilities[0].occurrence!.date = "2026-02-31";
    expect(semanticDraftSchema.safeParse(test.draft).success).toBe(false);
  });

  it("does not fabricate a timestamp without an anchor", () => {
    const test = fixture("Dentist appointment on Monday. Arrive 30 minutes before.");
    delete test.draft.responsibilities[0].occurrence!.startTime;
    delete test.draft.responsibilities[0].occurrence!.endTime;
    const result = compile(test);
    expect(result.tasks[1].fixedStartAt).toBeUndefined();
    expect(result.tasks[1].missingInformation.join(" ")).toContain("anchor date/time");
  });

  it("preserves times and review state through reconciliation, finalization, and serialization", () => {
    const test = fixture();
    const source = { ...input, text: test.text };
    const result = compile(test);
    const reconciled = reconcileHybridExtraction(source, result, { tasks: [], ignoredStatements: [] });
    const finalized = finalizeStagedExtraction(source, reconciled.result, { responsibilities: [], globalInstructions: [] }, { addLocallyInferredDependencies: false });
    const restored = validateAndDedupeExtraction(JSON.parse(JSON.stringify(finalized)));
    expect(restored.tasks[1]).toMatchObject({ taskType: "fixed_time", fixedStartAt: "2026-09-07T21:30:00.000Z", reviewRequired: true, approved: false });
  });

  it("shows the calculated fixed proposal without blocking the independent appointment", () => {
    const { tasks } = compile();
    const pending = schedule(tasks);
    expect(pending.sessions.map((session) => session.taskId)).toEqual(["arrival", "dentist"]);
    expect(pending.unschedulable).toEqual([]);
    const confirmed = schedule(tasks.map((task) => ({ ...task, reviewRequired: false, approved: true, missingInformation: [] })));
    expect(confirmed.unschedulable).toEqual([]);
    expect(confirmed.sessions.map((session) => session.taskId)).toEqual(["arrival", "dentist"]);
  });

  it("retains approximate arrivals as labeled, review-only proposals", () => {
    const test = fixture();
    test.draft.relations[0].approximate = true;
    const arrival = compile(test).tasks[1];
    expect(clock(arrival.fixedStartAt)).toBe("2026-09-07 14:30");
    expect(arrival.schedulingConstraints?.calculatedTiming?.approximate).toBe(true);
    expect(arrival.reviewRequired).toBe(true);
    expect(arrival.fieldProvenance?.find((field) => field.path === "fixedStartAt")?.rationale).toContain("Relationship not validated");
  });

  it("preserves a latest-arrival boundary and calculates travel from it", () => {
    const test = fixture("Dentist appointment at 3 PM on Monday. Arrive at least 30 minutes before. The journey needs 40 minutes.");
    test.draft.relations[0].mode = "latest";
    test.draft.responsibilities.push({ id: "journey", title: "Journey", kind: "task", sourceText: "The journey needs 40 minutes.", duration: { preferredMinutes: 40, explicit: true }, confidence: 1, missingInformation: [], reviewRequired: false });
    test.draft.relations.push({ fromId: "journey", toId: "arrival", relation: "before", strength: "hard", sourceText: test.text, reason: "The journey ends at arrival.", timing: "travel", fromBoundary: "end", toBoundary: "start", mode: "exact", minimumGapMinutes: 0 });
    const result = compile(test);
    expect(clock(result.tasks[1].fixedStartAt)).toBe("2026-09-07 14:30");
    expect(clock(result.tasks[2].fixedStartAt)).toBe("2026-09-07 13:50");
    expect(clock(result.tasks[2].fixedEndAt)).toBe("2026-09-07 14:30");
    expect(result.tasks[2].reviewRequired).toBe(true);
  });

  it("checks both minimum and maximum delays when calculating a work window", () => {
    const text = "Dentist appointment at 3 PM on Monday. Start the paperwork between 20 and 40 minutes after the appointment, and work for 10 minutes.";
    const test = fixture(text);
    test.draft.responsibilities[0].duration = { preferredMinutes: 60, explicit: true };
    test.draft.responsibilities[1] = { id: "paperwork", title: "Paperwork", kind: "task", sourceText: text.slice(text.indexOf("Start")), duration: { preferredMinutes: 10, explicit: true }, confidence: 1, missingInformation: [], reviewRequired: false };
    test.draft.relations = [{ fromId: "paperwork", toId: "dentist", relation: "after", strength: "hard", minimumGapMinutes: 20, maximumLagMinutes: 40, timing: "offset", fromBoundary: "start", toBoundary: "end", mode: "earliest", sourceText: text, reason: "Start within the specified interval." }];
    const task = compile(test).tasks[1];
    const window = task.schedulingConstraints?.allowedDateWindows?.[0];
    expect(clock(window?.start)).toBe("2026-09-07 16:20");
    expect(clock(window?.end)).toBe("2026-09-07 16:50");
    expect(task.reviewRequired).toBe(true);
  });

  it("rolls backwards across midnight from the anchor, ignoring the AI's proposed date", () => {
    const test = fixture("Dentist appointment at 12:10 AM on Monday. Arrive 30 minutes before.");
    test.draft.responsibilities[0].occurrence!.startTime = "00:10";
    test.draft.responsibilities[0].occurrence!.endTime = "01:10";
    expect(clock(compile(test).tasks[1].fixedStartAt)).toBe("2026-09-06 23:40");
  });
});
