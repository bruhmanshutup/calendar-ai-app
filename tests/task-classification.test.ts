import { describe, expect, it } from "vitest";
import { classifyTask, withResultClassifications } from "../lib/domain/task-classification";
import type { ExtractionResult } from "../lib/domain/types";
import { task } from "./fixtures";

describe("orthogonal task classification", () => {
  it.each([
    ["deadline", task({ id: "deadline", title: "Submit report", dueDate: "2026-09-14", deadlineStrength: "hard" }), { kind: "task", timing: "deadline", recurrence: "once" }],
    ["fixed event", task({ id: "event", title: "Attend meeting", taskType: "fixed_time", responsibilityKind: "event", fixedStartAt: "2026-09-10T14:00:00.000Z", fixedEndAt: "2026-09-10T14:30:00.000Z" }), { kind: "event", timing: "fixed_time", recurrence: "once" }],
    ["recurring event", task({ id: "series", title: "Attend lab", taskType: "recurring_goal", responsibilityKind: "event", recurrence: { frequency: "weekly", mode: "fixed_times", daysOfWeek: ["tuesday"], timeRules: [{ daysOfWeek: ["tuesday"], time: "09:00" }] } }), { kind: "event", timing: "fixed_time", recurrence: "recurring" }],
    ["flexible reminder", task({ id: "reminder", title: "Call dentist", responsibilityKind: "reminder" }), { kind: "reminder", timing: "flexible_window", recurrence: "once" }],
    ["all-day event", task({ id: "holiday", title: "University holiday", responsibilityKind: "event", sourceText: "University holiday: campus is closed all day on September 21, 2026." }), { kind: "event", timing: "all_day", recurrence: "once" }],
    ["all-day event with normalized midnight bounds", task({ id: "holiday-midnight", title: "University holiday", responsibilityKind: "event", taskType: "fixed_time", fixedStartAt: "2026-09-21T00:00:00.000Z", fixedEndAt: "2026-09-22T00:00:00.000Z", sourceText: "University holiday: campus is closed all day on September 21, 2026." }), { kind: "event", timing: "all_day", recurrence: "once" }],
    ["named-window reminder", task({ id: "morning-reminder", title: "Call dentist", responsibilityKind: "reminder", dueDate: "2026-09-02", sourceText: "Remind me to call the dentist tomorrow morning; no exact time is needed." }), { kind: "reminder", timing: "flexible_window", recurrence: "once" }],
    ["unresolved date", task({ id: "unknown", title: "Attend event", reviewRequired: true, approved: false, missingInformation: ["Confirm the year for this event date."], sourceText: "Attend event on 09/21." }), { kind: "task", timing: "unresolved", recurrence: "once" }],
  ] as const)("classifies %s without changing source facts", (_label, input, expected) => {
    expect(classifyTask(input)).toEqual(expected);
  });

  it("adds classification to a result while leaving legacy fields unchanged", () => {
    const input = task({ id: "report", title: "Submit report", dueDate: "2026-09-14" });
    const result: ExtractionResult = { tasks: [input], ignoredStatements: [] };
    const enriched = withResultClassifications(result);
    expect(enriched.tasks[0]).toMatchObject({ ...input, classification: { kind: "task", timing: "deadline", recurrence: "once" } });
    expect(enriched.tasks[0].dueDate).toBe(input.dueDate);
  });
});
