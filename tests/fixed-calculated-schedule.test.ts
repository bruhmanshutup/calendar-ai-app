import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { formatInTimeZone } from "date-fns-tz";
import { compileSemanticDraft } from "../lib/providers/semantic-draft-compiler";
import { semanticDraftSchema } from "../lib/providers/semantic-draft";
import { generateSchedule } from "../lib/domain/scheduler";
import { parsePersistedWorkspace } from "../lib/domain/workspace-state";
import { mergeImportedTasks } from "../lib/domain/task-import";
import { materializeCalculatedTimeBlock } from "../lib/domain/calculated-time-block";
import { arrivalBufferReservations } from "../lib/domain/linked-timing";
import { ScheduleSessionCard, TaskReviewCard } from "../app/components/planpilot-app";
import type { ExtractedTask } from "../lib/domain/types";
import { TEST_PREFERENCES } from "./fixtures";

const mocked = vi.hoisted(() => ({ tasks: [] as ExtractedTask[] }));
vi.mock("../app/components/planpilot-provider", () => ({ usePlanPilot: () => ({ tasks: mocked.tasks, selectedSessionIds: [], updateTask: vi.fn(), approveTask: vi.fn(), deleteTask: vi.fn() }) }));
const timeZone = "America/Los_Angeles";
const clock = (value?: string) => value ? formatInTimeZone(value, timeZone, "yyyy-MM-dd HH:mm") : undefined;

function extract(subject = "flight", minutes = 120) {
  const text = `i need to catch a 3 hour ${subject} at 6 pm on september 10 adn want to arrive 2 hours early`;
  const common = { sourceText: text, confidence: 1, missingInformation: [], reviewRequired: false };
  return compileSemanticDraft({ text, currentLocalDate: "2026-09-05", timeZone }, semanticDraftSchema.parse({
    responsibilities: [
      { ...common, id: "main", title: subject, kind: "event", occurrence: { date: "2026-09-10", dateSourceText: "september 10", startTime: "18:00", endTime: "21:00", confidence: 1 }, duration: { preferredMinutes: 180, explicit: true } },
      { ...common, id: "arrival", title: "Early arrival", kind: "milestone" },
    ],
    relations: [{ fromId: "arrival", toId: "main", timing: "arrival_buffer", relation: "before", strength: "hard", fromBoundary: "start", toBoundary: "start", minimumGapMinutes: minutes, mode: "exact", reason: "AI-interpreted early arrival" }],
    blockedTimes: [], globalInstructions: [], ignoredStatements: [],
  })).tasks;
}
function schedule(tasks: ExtractedTask[]) {
  return generateSchedule({ tasks, windowStart: "2026-09-10T07:00:00Z", windowEnd: "2026-09-11T07:00:00Z", preferences: { ...TEST_PREFERENCES, timeZone }, availability: [{ start: "2026-09-10T14:00:00Z", end: "2026-09-11T06:00:00Z" }], unavailableEvents: [], blockedTimes: [], lockedSessions: [] });
}
function legacyTasks() {
  const tasks = extract();
  tasks[1] = { ...tasks[1], taskType: "flexible", responsibilityKind: "milestone", fixedStartAt: undefined, fixedEndAt: undefined, dueAt: "2026-09-10T23:00:00.000Z", dueDate: "2026-09-10", dueTime: "16:00", estimatedMinutes: undefined, minimumSessionMinutes: undefined };
  return tasks;
}

describe("fixed arrival blocks on the actual schedule", () => {
  it.each([["flight", 120, "16:00"], ["workshop", 45, "17:15"], ["performance", 90, "16:30"]])("schedules both %s and its calculated buffer without prior task approval", (subject, minutes, start) => {
    const tasks = extract(subject, minutes);
    expect(tasks[1]).toMatchObject({ taskType: "fixed_time", responsibilityKind: "event", estimatedMinutes: minutes, reviewRequired: true, approved: false });
    expect(clock(tasks[1].fixedStartAt)).toBe(`2026-09-10 ${start}`);
    expect(clock(tasks[1].fixedEndAt)).toBe("2026-09-10 18:00");
    const proposal = schedule(tasks);
    expect(proposal.unschedulable).toEqual([]);
    expect(proposal.sessions.map((session) => session.taskId)).toEqual(["arrival", "main"]);
    expect(proposal.sessions[0]).toMatchObject({ start: tasks[1].fixedStartAt, end: tasks[1].fixedEndAt, status: "proposed", locked: true, reasonCodes: ["FIXED_TIME"] });
    expect(proposal.sessions[0].explanation).toContain("Check this fixed proposal");
    expect(proposal.plannedMinutes).toBe(180 + minutes);
    expect(arrivalBufferReservations(tasks, true)).toEqual([]);
  });

  it("renders ordinary task fields and a labelled calendar card with the calculated interval", () => {
    const tasks = extract();
    mocked.tasks = tasks;
    const proposal = schedule(tasks);
    const html = renderToStaticMarkup(createElement(ScheduleSessionCard, { session: proposal.sessions[0] }));
    expect(html).toContain("4:00 PM–6:00 PM");
    expect(html).toContain("Early arrival");
    expect(html).toContain("Calculated · check timing");
    const taskHtml = renderToStaticMarkup(createElement(TaskReviewCard, { task: tasks[1] }));
    expect(taskHtml).toContain('value="2026-09-10T16:00"');
    expect(taskHtml).toContain('value="2026-09-10T18:00"');
    expect(taskHtml).toContain("September 10");
  });

  it("upgrades a previously saved checkpoint on refresh and schedules it once", () => {
    const tasks = legacyTasks();
    const previous = schedule([tasks[0]]);
    const saved = parsePersistedWorkspace(JSON.parse(JSON.stringify({ version: 1, schedulerVersion: 13, tasks, proposal: previous, importText: "", history: [], sessionReviews: [], planningMode: "balanced" })));
    expect(saved.tasks[1].id).toBe("arrival");
    expect(saved.tasks[1].taskType).toBe("fixed_time");
    expect(schedule(saved.tasks).sessions).toHaveLength(2);
    expect(schedule(tasks).sessions).toHaveLength(2);
    expect(tasks[1].taskType).toBe("flexible"); // Non-mutating migration.
  });

  it("refreshes the old checkpoint on reimport rather than creating a duplicate", () => {
    const merged = mergeImportedTasks(legacyTasks(), extract());
    expect(merged.tasks).toHaveLength(2);
    expect(merged.tasks[1].taskType).toBe("fixed_time");
    expect(schedule(merged.tasks).sessions).toHaveLength(2);
  });

  it("preserves manual timing/type overrides and does not invent missing operands", () => {
    const legacy = legacyTasks()[1];
    legacy.fieldProvenance = [{ path: "taskType", origin: "user" }];
    expect(materializeCalculatedTimeBlock(legacy)).toBe(legacy);
    const missing = { ...legacy, fieldProvenance: [], schedulingConstraints: undefined };
    expect(materializeCalculatedTimeBlock(missing)).toBe(missing);
  });

  it("continues to block main events requiring validation", () => {
    const tasks = extract();
    tasks[0].reviewRequired = true;
    tasks[0].approved = false;
    tasks[0].missingInformation = ["Confirm the event date."];
    const proposal = schedule(tasks);
    expect(proposal.sessions.map((session) => session.taskId)).toEqual(["arrival"]);
    expect(proposal.unschedulable[0]).toMatchObject({ taskId: "main", reasonCode: "MISSING_REQUIRED_INFORMATION" });
  });
});
