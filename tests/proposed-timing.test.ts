import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { formatInTimeZone } from "date-fns-tz";
import { TaskReviewCard, UnschedulableTaskCard } from "../app/components/planpilot-app";
import { compileSemanticDraft } from "../lib/providers/semantic-draft-compiler";
import { semanticDraftSchema, type SemanticDraft } from "../lib/providers/semantic-draft";
import { validateAndDedupeExtraction } from "../lib/domain/extraction-schema";
import { reconcileHybridExtraction } from "../lib/providers/hybrid-reconciliation";
import { finalizeStagedExtraction } from "../lib/providers/staged-extraction";
import { generateSchedule } from "../lib/domain/scheduler";
import { TEST_PREFERENCES } from "./fixtures";

// These fixtures are written in Pacific time, so render the app's clock labels in Pacific too.
vi.mock("../lib/defaults", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/defaults")>();
  return { ...original, DEFAULT_PREFERENCES: { ...original.DEFAULT_PREFERENCES, timeZone: "America/Los_Angeles" } };
});


vi.mock("../app/components/planpilot-provider", () => ({
  usePlanPilot: () => ({ updateTask: vi.fn(), approveTask: vi.fn(), deleteTask: vi.fn() }),
}));

const context = { currentLocalDate: "2026-09-05", timeZone: "America/Los_Angeles", sourceId: "proposed-clock-regression" };
const clock = (value?: string) => value ? formatInTimeZone(value, context.timeZone, "yyyy-MM-dd HH:mm") : undefined;

function fixture(clockText = "5", travelApproximate = true) {
  const text = `dentist appointment at ${clockText} on september 9, travel time takes around 30 minutes.`;
  const draft: SemanticDraft = {
    responsibilities: [
      { id: "dentist", title: "Dentist appointment", kind: "event", sourceText: text.split(",")[0], occurrence: { date: "2026-09-09", startTime: "17:00", confidence: 1 }, duration: { preferredMinutes: 45, explicit: false }, confidence: 1, missingInformation: [], reviewRequired: false },
      { id: "travel", title: "Travel to dentist", kind: "task", sourceText: "travel time takes around 30 minutes.", duration: { preferredMinutes: 30, explicit: true, approximate: travelApproximate }, confidence: 1, missingInformation: [], reviewRequired: false },
    ],
    relations: [{ fromId: "travel", toId: "dentist", relation: "before", strength: "hard", minimumGapMinutes: 0, sourceText: text, fromText: "travel time", toText: "dentist appointment", timing: "travel", fromBoundary: "end", toBoundary: "start", mode: "exact", approximate: false, reason: "Travel ends at the appointment." }],
    blockedTimes: [], globalInstructions: [], ignoredStatements: [],
  };
  return { text, draft };
}

function extract(test = fixture()) {
  const input = { ...context, text: test.text };
  const compiled = validateAndDedupeExtraction(compileSemanticDraft(input, semanticDraftSchema.parse(test.draft)));
  const reconciled = reconcileHybridExtraction(input, compiled, { tasks: [], ignoredStatements: [] });
  const finalized = finalizeStagedExtraction(input, reconciled.result, { responsibilities: [], globalInstructions: [] }, { addLocallyInferredDependencies: false });
  return validateAndDedupeExtraction(JSON.parse(JSON.stringify(finalized)));
}

describe("visible review-only appointment anchors and calculated travel", () => {
  it.each(["", "tomorrow"])("marks the date provisional when its source evidence is absent: %s", (dateSourceText) => {
    const test = fixture("5 PM");
    test.draft.responsibilities[0].occurrence!.dateSourceText = dateSourceText;
    const dentist = extract(test).tasks[0];
    expect(dentist.reviewRequired).toBe(true);
    expect(dentist.missingInformation.join(" ")).toContain("date is provisional");
    expect(dentist.fixedStartAt).toBeDefined();
  });

  it("accepts a shared date quoted separately from the event's own sentence", () => {
    const test = fixture("5 PM");
    test.draft.responsibilities[0].occurrence!.dateSourceText = "september 9";
    expect(extract(test).tasks[0].missingInformation.join(" ")).not.toContain("date is provisional");
  });
  it.each(["5", "five"])("retains the AI's proposal for '%s', without calling it a verified clock", (clockText) => {
    const { tasks: [dentist, travel] } = extract(fixture(clockText));
    expect(clock(dentist.fixedStartAt)).toBe("2026-09-09 17:00");
    expect(clock(dentist.fixedEndAt)).toBe("2026-09-09 17:45");
    expect(dentist).toMatchObject({ taskType: "fixed_time", reviewRequired: true, approved: false });
    expect(dentist.missingInformation.join(" ")).toContain("AM/PM");
    expect(dentist.missingInformation).not.toContain("Confirm the exact time; it does not appear in the source text.");
    expect(dentist.fieldProvenance).toContainEqual(expect.objectContaining({ path: "fixedStartAt", origin: "inferred" }));
    expect(clock(travel.fixedStartAt)).toBe("2026-09-09 16:30");
    expect(clock(travel.fixedEndAt)).toBe("2026-09-09 17:00");
    expect(travel).toMatchObject({ reviewRequired: true, approved: false });
  });

  it("propagates an uncertain anchor even when the travel duration and relationship are exact", () => {
    const travel = extract(fixture("5", false)).tasks[1];
    expect(clock(travel.fixedStartAt)).toBe("2026-09-09 16:30");
    expect(travel.schedulingConstraints?.calculatedTiming).toMatchObject({ approximate: true });
    expect(travel.schedulingConstraints?.linkedTiming).toBeUndefined();
  });

  it("also preserves an AM proposal without silently substituting PM", () => {
    const test = fixture();
    test.draft.responsibilities[0].occurrence!.startTime = "05:00";
    const { tasks: [dentist, travel] } = extract(test);
    expect(clock(dentist.fixedStartAt)).toBe("2026-09-09 05:00");
    expect(clock(travel.fixedStartAt)).toBe("2026-09-09 04:30");
    expect(dentist.reviewRequired).toBe(true);
    expect(travel.reviewRequired).toBe(true);
  });

  it("preserves explicit PM as explicit, while keeping approximate travel reviewable", () => {
    const { tasks: [dentist, travel] } = extract(fixture("5 PM"));
    expect(clock(dentist.fixedStartAt)).toBe("2026-09-09 17:00");
    expect(dentist.fieldProvenance).toContainEqual(expect.objectContaining({ path: "fixedStartAt", origin: "explicit" }));
    expect(dentist.missingInformation.join(" ")).not.toContain("AM/PM");
    expect(clock(travel.fixedStartAt)).toBe("2026-09-09 16:30");
  });

  it("does not manufacture an appointment or travel clock if the AI supplied no anchor", () => {
    const test = fixture();
    delete test.draft.responsibilities[0].occurrence!.startTime;
    const { tasks: [dentist, travel] } = extract(test);
    expect(dentist.fixedStartAt).toBeUndefined();
    expect(travel.fixedStartAt).toBeUndefined();
    expect(travel.schedulingConstraints?.preferredDateWindows).toBeUndefined();
    const html = renderToStaticMarkup(createElement(TaskReviewCard, { task: dentist }));
    expect(html).toContain("September 9");
    expect(html).toContain("Event date · time needs review");
  });

  it("does not retain a proposal when its responsibility quote is fabricated", () => {
    const test = fixture();
    test.draft.responsibilities[0].sourceText = "A fabricated dentist sentence.";
    const result = compileSemanticDraft({ ...context, text: test.text }, semanticDraftSchema.parse(test.draft));
    expect(result.tasks[0].fixedStartAt).toBeUndefined();
    expect(result.tasks[1].schedulingConstraints?.preferredDateWindows).toBeUndefined();
  });

  it("renders the actual date, start, and end on task cards, not just the window label", () => {
    const { tasks: [dentist, travel] } = extract();
    const appointmentHtml = renderToStaticMarkup(createElement(TaskReviewCard, { task: dentist }));
    expect(appointmentHtml).toContain("Proposed event time");
    expect(appointmentHtml).toContain("Wednesday, September 9");
    expect(appointmentHtml).toContain("5:00 PM–5:45 PM");
    const travelHtml = renderToStaticMarkup(createElement(TaskReviewCard, { task: travel }));
    expect(travelHtml).toContain("Proposed event time");
    expect(travelHtml).toContain("Calculated · independent");
    expect(travelHtml).toContain("Estimated timing");
    expect(travelHtml).toContain('value="2026-09-09T16:30"');
    expect(travelHtml).toContain('value="2026-09-09T17:00"');
    expect(travelHtml).toContain("Wednesday, September 9");
    expect(travelHtml).toContain("4:30 PM–5:00 PM");
  });

  it("shows both dates when a proposed interval crosses local midnight", () => {
    const travel = extract().tasks[1];
    travel.fixedStartAt = "2026-09-09T06:40:00Z";
    travel.fixedEndAt = "2026-09-09T07:10:00Z";
    const html = renderToStaticMarkup(createElement(TaskReviewCard, { task: travel }));
    expect(html).toContain("Tuesday, September 8 at 11:40 PM");
    expect(html).toContain("Wednesday, September 9 at 12:10 AM");
  });

  it("shows calculated fixed proposals while still blocking an unconfirmed main-event anchor", () => {
    const { tasks } = extract();
    const proposal = generateSchedule({ tasks, windowStart: "2026-09-09T07:00:00Z", windowEnd: "2026-09-10T07:00:00Z", preferences: { ...TEST_PREFERENCES, timeZone: context.timeZone }, availability: [{ start: "2026-09-09T14:00:00Z", end: "2026-09-10T05:00:00Z" }], unavailableEvents: [], blockedTimes: [], lockedSessions: [] });
    expect(proposal.sessions.map((session) => session.taskId)).toEqual(["travel"]);
    expect(proposal.sessions[0].explanation).toContain("Check this fixed proposal");
    expect(proposal.unschedulable).toHaveLength(1);
    for (const task of proposal.unschedulable) {
      const responsibility = tasks.find((item) => item.id === task.taskId)!;
      const html = renderToStaticMarkup(createElement(UnschedulableTaskCard, { task, responsibility }));
      expect(html).toContain("Proposed timing (needs review)");
      expect(html).toContain("September 9");
      expect(html).toContain(task.taskId === "travel" ? "4:30 PM–5:00 PM" : "5:00 PM–5:45 PM");
    }
  });
});
