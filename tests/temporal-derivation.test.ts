import { describe, expect, it } from "vitest";
import { formatInTimeZone } from "date-fns-tz";
import { compileSemanticDraft } from "../lib/providers/semantic-draft-compiler";
import type { SemanticDraft } from "../lib/providers/semantic-draft";
import { verifiedWorkDuration, verifyTemporalRelation } from "../lib/providers/temporal-evidence";
import { validateAndDedupeExtraction } from "../lib/domain/extraction-schema";
import { generateSchedule } from "../lib/domain/scheduler";
import { reconcileHybridExtraction } from "../lib/providers/hybrid-reconciliation";
import { TEST_PREFERENCES } from "./fixtures";

type Item = SemanticDraft["responsibilities"][number];
type Link = SemanticDraft["relations"][number];
const date = "2026-09-05";
const input = { currentLocalDate: date, timeZone: "America/Los_Angeles" };
const clock = (value?: string) => value ? formatInTimeZone(value, input.timeZone, "yyyy-MM-dd HH:mm") : undefined;
function item(id: string, title: string, sourceText: string, patch: Partial<Item> = {}): Item {
  return { id, title, sourceText, kind: "task", confidence: 0.98, missingInformation: [], reviewRequired: false, ...patch };
}
function link(fromId: string, toId: string, sourceText: string, patch: Partial<Link> = {}): Link {
  return { fromId, toId, sourceText, relation: "before", strength: "hard", reason: "Model candidate", ...patch };
}
function compile(text: string, responsibilities: Item[], relations: Link[]) {
  return validateAndDedupeExtraction(compileSemanticDraft({ ...input, text }, { responsibilities, relations, blockedTimes: [], globalInstructions: [], ignoredStatements: [] }));
}
function flightFixture(approximate = false) {
  const flightText = "My flight is today at 6:05 AM.";
  const arrivalText = "I need to arrive two hours early.";
  const travelText = `It takes ${approximate ? "about " : ""}40 minutes to drive there.`;
  const text = `${flightText} ${arrivalText} ${travelText}`;
  const responsibilities = [
    item("drive", "Drive to airport", travelText, { kind: "event", duration: { preferredMinutes: 40, explicit: true, approximate }, occurrence: { date, startTime: "02:45", endTime: "03:25", confidence: 0.95 } }),
    item("arrival", "Arrive at airport", arrivalText, { kind: "event", occurrence: { date, startTime: "04:05", endTime: "06:05", confidence: 0.95 } }),
    item("flight", "Flight", flightText, { kind: "event", occurrence: { date, startTime: "06:05", endTime: "07:05", confidence: 0.99 }, duration: { preferredMinutes: 60, explicit: false } }),
  ];
  const relations = [
    link("drive", "arrival", `${arrivalText} ${travelText}`, { timing: "travel", fromText: "drive", toText: "arrive" }),
    link("arrival", "flight", `${flightText} ${arrivalText}`, { timing: "arrival_buffer", minimumGapMinutes: 120, fromText: "arrive", toText: "flight" }),
  ];
  return { text, responsibilities, relations };
}

describe("temporal arithmetic and quoted interpretation", () => {
  it.each([
    ["30 minutes", 30],
    ["half an hour", 30],
    ["half hour", 30],
    ["half of an hour", 30],
    ["a quarter of an hour", 15],
    ["one and a half hours", 90],
    ["an hour and a half", 90],
  ])("normalizes the whole duration phrase: %s", (phrase, minutes) => {
    const source = `Arrive ${phrase} before the flight.`;
    const from = item("arrival", "Arrive at airport", source, { kind: "milestone" });
    const to = item("flight", "Flight", source);
    const verified = verifyTemporalRelation({ ...input, text: source }, link("arrival", "flight", source, { minimumGapMinutes: minutes, fromText: "Arrive", toText: "flight" }), from, to);
    expect(verified?.minutes).toBe(minutes);
    expect(verified?.evidence.quote).toBe(source);
    const workSource = `Driving takes ${phrase}.`;
    const work = item("drive", "Driving", workSource, { duration: { preferredMinutes: minutes, explicit: true } });
    expect(verifiedWorkDuration(work, { ...input, text: workSource })?.minutes).toBe(minutes);
  });

  it.each(["twenty five minutes", "an hour and 20 minutes", "one hundred minutes"])("rejects partial readings of unsupported compounds: %s", (phrase) => {
    const source = `Arrive ${phrase} before the flight.`;
    expect(verifyTemporalRelation({ ...input, text: source }, link("arrival", "flight", source, { minimumGapMinutes: 20 }), item("arrival", "Arrive", source), item("flight", "Flight", source))).toBeUndefined();
    const workSource = `Driving takes ${phrase}.`;
    expect(verifiedWorkDuration(item("drive", "Driving", workSource, { duration: { preferredMinutes: 20, explicit: true } }), { ...input, text: workSource })).toBeUndefined();
  });

  it("derives arrival and travel from fractional wording through the complete compiler", () => {
    const source = "The flight is today at 6:05 AM. Arrive half an hour before the flight. Driving takes an hour and a half.";
    const result = compile(source, [
      item("flight", "Flight", "The flight is today at 6:05 AM.", { kind: "event", occurrence: { date, startTime: "06:05", confidence: 1 } }),
      item("arrival", "Arrive at airport", "Arrive half an hour before the flight.", { kind: "milestone" }),
      item("drive", "Driving to airport", "Driving takes an hour and a half.", { duration: { preferredMinutes: 90, explicit: true } }),
    ], [
      link("arrival", "flight", "Arrive half an hour before the flight.", { timing: "arrival_buffer", minimumGapMinutes: 30, fromText: "Arrive", toText: "flight" }),
      link("drive", "arrival", "Arrive half an hour before the flight. Driving takes an hour and a half.", { timing: "travel", fromText: "Driving", toText: "Arrive" }),
    ]);
    expect(clock(result.tasks[1].fixedStartAt)).toBe(`${date} 05:35`);
    expect(clock(result.tasks[2].fixedStartAt)).toBe(`${date} 04:05`);
    expect(clock(result.tasks[2].fixedEndAt)).toBe(`${date} 05:35`);
    expect(result.tasks[2].estimatedMinutes).toBe(90);
  });

  it("replaces incorrect AI arithmetic and solves a reversed-order travel chain", () => {
    const fixture = flightFixture();
    const result = compile(fixture.text, fixture.responsibilities, fixture.relations);
    const drive = result.tasks.find((task) => task.id === "drive")!;
    const arrival = result.tasks.find((task) => task.id === "arrival")!;
    expect(clock(drive.fixedStartAt)).toBe(`${date} 03:25`);
    expect(clock(drive.fixedEndAt)).toBe(`${date} 04:05`);
    expect(clock(arrival.fixedStartAt)).toBe(`${date} 04:05`);
    expect(arrival.responsibilityKind).toBe("event");
    expect(arrival.estimatedMinutes).toBe(120);
    expect(drive.reviewRequired).toBe(true);
    expect(drive.fieldProvenance).toContainEqual(expect.objectContaining({ path: "fixedStartAt", origin: "derived", rationale: expect.stringContaining("Relationship not validated") }));
    const proposal = generateSchedule({ tasks: result.tasks.map((task) => ({ ...task, reviewRequired: false, approved: true })), windowStart: "2026-09-05T07:00:00Z", windowEnd: "2026-09-06T07:00:00Z", preferences: { ...TEST_PREFERENCES, timeZone: input.timeZone, wakingTime: "00:00", sleepingTime: "23:59" }, availability: [{ start: "2026-09-05T07:00:00Z", end: "2026-09-06T06:59:00Z" }], unavailableEvents: [], blockedTimes: [], lockedSessions: [] });
    expect(proposal.sessions.find((session) => session.taskId === "drive")?.start).toBe(drive.fixedStartAt);
    expect(proposal.unschedulable).toEqual([]);
  });

  it("keeps approximate travel as a proposed slot, with an independently derived arrival", () => {
    const fixture = flightFixture(true);
    const result = compile(fixture.text, fixture.responsibilities, fixture.relations);
    const drive = result.tasks[0];
    expect(drive).toMatchObject({ taskType: "fixed_time", fixedStartAt: "2026-09-05T10:25:00.000Z", fixedEndAt: "2026-09-05T11:05:00.000Z" });
    expect(drive.schedulingConstraints?.calculatedTiming?.approximate).toBe(true);
    expect(clock(result.tasks[1].fixedStartAt)).toBe(`${date} 04:05`);
    expect(drive.dependencies).toBeUndefined();
    const proposal = generateSchedule({ tasks: result.tasks.map((task) => ({ ...task, reviewRequired: false, approved: true })), windowStart: "2026-09-05T07:00:00Z", windowEnd: "2026-09-06T07:00:00Z", preferences: { ...TEST_PREFERENCES, timeZone: input.timeZone, wakingTime: "00:00", sleepingTime: "23:59" }, availability: [{ start: "2026-09-05T07:00:00Z", end: "2026-09-06T06:59:00Z" }], unavailableEvents: [], blockedTimes: [], lockedSessions: [] });
    expect(clock(proposal.sessions.find((session) => session.taskId === "drive")?.end)).toBe(`${date} 04:05`);
  });

  it("calculates using the model's numeric interpretation and requires its confirmation", () => {
    const fixture = flightFixture();
    fixture.relations[1].minimumGapMinutes = 17;
    const result = compile(fixture.text, fixture.responsibilities, fixture.relations);
    expect(clock(result.tasks[1].fixedStartAt)).toBe(`${date} 05:48`);
    expect(result.tasks[1].dependencies).toBeUndefined();
    expect(result.tasks[1].reviewRequired).toBe(true);
  });

  it("preserves the real homework deadline while enforcing completion before departure", () => {
    const fixture = flightFixture();
    const homework = "Finish my math homework before I drive to the airport. Homework takes 90 minutes and is due today at 3 PM.";
    const result = compile(`${fixture.text} ${homework}`, [...fixture.responsibilities, item("homework", "Finish math homework", homework, { duration: { preferredMinutes: 90, explicit: true }, deadline: { date, time: "15:00", strength: "hard", confidence: 0.99 } })], [...fixture.relations, link("homework", "drive", homework, { fromText: "math homework", toText: "drive" })]);
    const task = result.tasks.at(-1)!;
    expect(task.dueTime).toBe("15:00");
    expect(clock(task.fixedEndAt)).toBe(`${date} 03:25`);
    expect(clock(task.fixedStartAt)).toBe(`${date} 01:55`);
    expect(task.dependencies).toBeUndefined();
  });

  it.each([
    "Clean the kitchen before the inspection.",
    "Before the inspection, clean the kitchen.",
    "Clean the kitchen prior to the inspection.",
  ])("checks order without forcing exact equality: %s", (text) => {
    const result = compile(text, [item("clean", "Clean kitchen", text), item("inspection", "Inspection", text)], [link("clean", "inspection", text)]);
    expect(result.tasks[0].dependencies?.[0].relation).toBe("before");
    expect(result.tasks[0].fixedStartAt).toBeUndefined();
  });

  it.each([
    "Clean the kitchen after the inspection.",
    "Do not clean the kitchen before the inspection.",
    "Clean the kitchen. The inspection is tomorrow.",
  ])("keeps the AI candidate for review without treating its real quote as proof: %s", (text) => {
    const result = compile(text, [item("clean", "Clean kitchen", text, { kind: "event", occurrence: { date, startTime: "11:00", endTime: "12:00", confidence: 0.99 } }), item("inspection", "Inspection", text)], [link("clean", "inspection", text)]);
    expect(result.tasks[0].dependencies?.[0].relation).toBe("before");
    expect(result.tasks[0].fixedStartAt).toBeUndefined();
    expect(result.tasks[0].taskType).toBe("flexible");
    expect(result.tasks[0].reviewRequired).toBe(true);
  });

  it("does not accept fabricated quotes or a mismatched relationship target", () => {
    const text = "Clean the kitchen before the inspection. Call the bank today at 10 AM.";
    const clean = item("clean", "Clean kitchen", text);
    const bank = item("bank", "Call bank", text);
    expect(verifyTemporalRelation({ ...input, text }, link("clean", "bank", text), clean, bank)).toBeUndefined();
    expect(verifyTemporalRelation({ ...input, text }, link("clean", "bank", "Clean the kitchen before calling the bank."), clean, bank)).toBeUndefined();
  });

  it("calculates a stated start offset after an anchored event", () => {
    const event = "The inspection is today from 10 AM to 11 AM.";
    const clean = "Start cleaning 20 minutes after the inspection. Cleaning takes 30 minutes.";
    const result = compile(`${event} ${clean}`, [item("inspection", "Inspection", event, { kind: "event", occurrence: { date, startTime: "10:00", endTime: "11:00", confidence: 1 } }), item("clean", "Start cleaning", clean, { duration: { preferredMinutes: 30, explicit: true } })], [link("clean", "inspection", clean, { relation: "after", minimumGapMinutes: 20, timing: "offset" })]);
    expect(clock(result.tasks[1].fixedStartAt)).toBe(`${date} 11:20`);
    expect(clock(result.tasks[1].fixedEndAt)).toBe(`${date} 11:50`);
  });

  it("calculates the same offset when the AI expresses the relation in reverse", () => {
    const event = "The inspection is today from 10 AM to 11 AM.";
    const clean = "Start cleaning 20 minutes after the inspection. Cleaning takes 30 minutes.";
    const result = compile(`${event} ${clean}`, [item("inspection", "Inspection", event, { kind: "event", occurrence: { date, startTime: "10:00", endTime: "11:00", confidence: 1 } }), item("clean", "Cleaning", clean, { duration: { preferredMinutes: 30, explicit: true } })], [link("inspection", "clean", clean, { minimumGapMinutes: 20, timing: "offset", fromBoundary: "end", toBoundary: "start" })]);
    expect(clock(result.tasks[1].fixedStartAt)).toBe(`${date} 11:20`);
    expect(clock(result.tasks[1].fixedEndAt)).toBe(`${date} 11:50`);
  });

  it("removes unsupported clocks embedded in a milestone window", () => {
    const text = "I need to arrive early, but I am not sure when.";
    const result = compile(text, [item("arrival", "Arrive", text, { kind: "milestone", occurrence: { date, startTime: "04:05", confidence: 0.9 }, constraints: { allowedWindows: [{ date, startTime: "04:05", endTime: "05:05", label: "Proposed arrival" }] } })], []);
    expect(JSON.stringify(result.tasks[0].schedulingConstraints)).not.toContain("11:05:00");
    expect(result.tasks[0].reviewRequired).toBe(true);
  });

  it("does not use an unrelated event clock as a travel anchor", () => {
    const fixture = flightFixture();
    fixture.responsibilities[0].sourceText = fixture.text;
    fixture.responsibilities[0].occurrence!.startTime = "06:05";
    const result = compile(fixture.text, fixture.responsibilities, fixture.relations);
    expect(clock(result.tasks[0].fixedStartAt)).toBe(`${date} 03:25`);
  });

  it("keeps the calculated clock and relationship review through the secondary parser", () => {
    const fixture = flightFixture();
    const result = compile(fixture.text, fixture.responsibilities, fixture.relations);
    const local = structuredClone(result.tasks[0]);
    local.fixedStartAt = "2026-09-05T13:05:00.000Z";
    local.fieldConfidence.dueTime = 1;
    const reconciled = reconcileHybridExtraction({ ...input, text: fixture.text }, result, { tasks: [local], ignoredStatements: [] });
    expect(reconciled.result.tasks[0].reviewRequired).toBe(true);
    expect(reconciled.result.tasks[0].missingInformation).toEqual(result.tasks[0].missingInformation);
    expect(clock(reconciled.result.tasks[0].fixedStartAt)).toBe(`${date} 03:25`);
  });

  it("requires review of the AI's duration attribution rather than claiming to verify its meaning", () => {
    const fixture = flightFixture();
    fixture.text = fixture.text.replace("It takes 40 minutes to drive there.", "I will drive there. The laundry takes 40 minutes.");
    fixture.responsibilities[0].sourceText = "I will drive there. The laundry takes 40 minutes.";
    fixture.relations[0].sourceText = fixture.relations[0].sourceText!.replace("It takes 40 minutes to drive there.", fixture.responsibilities[0].sourceText);
    const result = compile(fixture.text, fixture.responsibilities, fixture.relations);
    expect(clock(result.tasks[0].fixedStartAt)).toBe(`${date} 03:25`);
    expect(result.tasks[0].reviewRequired).toBe(true);
  });

  it("handles midnight rollover without trusting the model's date", () => {
    const fixture = flightFixture();
    fixture.text = fixture.text.replace("6:05 AM", "1:05 AM");
    fixture.responsibilities[2].sourceText = fixture.responsibilities[2].sourceText.replace("6:05 AM", "1:05 AM");
    fixture.responsibilities[2].occurrence!.startTime = "01:05";
    fixture.responsibilities[2].occurrence!.endTime = "02:05";
    fixture.relations[1].sourceText = fixture.relations[1].sourceText!.replace("6:05 AM", "1:05 AM");
    const result = compile(fixture.text, fixture.responsibilities, fixture.relations);
    expect(clock(result.tasks[0].fixedStartAt)).toBe("2026-09-04 22:25");
    expect(clock(result.tasks[1].fixedStartAt)).toBe("2026-09-04 23:05");
  });

  it("labels a travel placement based on an unstated duration as estimated and pending review", () => {
    const fixture = flightFixture();
    fixture.text = fixture.text.replace("It takes 40 minutes to drive there.", "I will drive there.");
    fixture.responsibilities[0].sourceText = "I will drive there.";
    fixture.relations[0].sourceText = fixture.relations[0].sourceText!.replace("It takes 40 minutes to drive there.", "I will drive there.");
    fixture.responsibilities[0].duration!.explicit = false;
    const result = compile(fixture.text, fixture.responsibilities, fixture.relations);
    expect(result.tasks[0].fixedStartAt).toBe("2026-09-05T10:25:00.000Z");
    expect(result.tasks[0].schedulingConstraints?.calculatedTiming?.durationEstimated).toBe(true);
    expect(result.tasks[0].reviewRequired).toBe(true);
    expect(clock(result.tasks[1].fixedStartAt)).toBe(`${date} 04:05`);
  });

  it("flags dependency cycles while leaving an independent event intact", () => {
    const text = "Clean the kitchen before painting. Finish painting before cleaning the kitchen. Lunch is today at noon.";
    const result = compile(text, [item("clean", "Clean kitchen", "Clean the kitchen before painting."), item("paint", "Finish painting", "Finish painting before cleaning the kitchen."), item("lunch", "Lunch", "Lunch is today at noon.", { kind: "event", occurrence: { date, startTime: "12:00", confidence: 1 } })], [link("clean", "paint", "Clean the kitchen before painting."), link("paint", "clean", "Finish painting before cleaning the kitchen.")]);
    expect(result.tasks[0].reviewRequired).toBe(true);
    expect(result.tasks[1].reviewRequired).toBe(true);
    expect(clock(result.tasks[2].fixedStartAt)).toBe(`${date} 12:00`);
  });

  it.each([
    ["Pickup is today between 4 and 5 PM.", "16:00", "17:00"],
    ["Dinner is tonight at 7.", "19:00", "19:45"],
  ])("retains safely normalized clocks: %s", (text, startTime, endTime) => {
    const result = compile(text, [item("event", "Event", text, { kind: "event", occurrence: { date, startTime, endTime, confidence: 1 } })], []);
    expect(clock(result.tasks[0].fixedStartAt)).toBe(`${date} ${startTime}`);
  });
});
