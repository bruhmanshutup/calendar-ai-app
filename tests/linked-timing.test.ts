import { describe, expect, it } from "vitest";
import { formatInTimeZone } from "date-fns-tz";
import { compileSemanticDraft } from "../lib/providers/semantic-draft-compiler";
import { semanticDraftSchema } from "../lib/providers/semantic-draft";
import { extractedTaskSchema, validateAndDedupeExtraction } from "../lib/domain/extraction-schema";
import { applyLinkedTaskEdit, arrivalBufferReservations, recalculateLinkedTiming } from "../lib/domain/linked-timing";
import { generateSchedule } from "../lib/domain/scheduler";
import { mergeImportedTasks } from "../lib/domain/task-import";
import { parsePersistedWorkspace } from "../lib/domain/workspace-state";
import { toSupabaseTaskRow } from "../lib/repositories/supabase-task-row";
import { task, TEST_PREFERENCES } from "./fixtures";
import type { ExtractedTask } from "../lib/domain/types";

const timeZone = "America/Los_Angeles";
const clock = (value?: string) => value ? formatInTimeZone(value, timeZone, "yyyy-MM-dd HH:mm") : undefined;
function airport() {
  const text = "On September 9, I need to get to the airport 3 hours early, which takes around 30 minutes to travel from home to airport for my 3 hour flight at 6pm.";
  const common = { sourceText: text, confidence: 1, missingInformation: [], reviewRequired: false };
  const draft = semanticDraftSchema.parse({
    responsibilities: [
      { ...common, id: "drive", title: "Travel to airport", kind: "task", duration: { preferredMinutes: 30, explicit: true, approximate: true } },
      { ...common, id: "arrival", title: "Arrive at airport", kind: "milestone" },
      { ...common, id: "flight", title: "Flight", kind: "event", occurrence: { date: "2026-09-09", startTime: "18:00", endTime: "21:00", confidence: 1 }, duration: { preferredMinutes: 180, explicit: true } },
    ],
    relations: [
      { fromId: "drive", toId: "arrival", relation: "before", strength: "hard", minimumGapMinutes: 0, sourceText: text, timing: "travel", fromBoundary: "end", toBoundary: "start", mode: "exact", approximate: false, reason: "Travel ends at arrival." },
      { fromId: "arrival", toId: "flight", relation: "before", strength: "hard", minimumGapMinutes: 180, sourceText: text, timing: "arrival_buffer", fromBoundary: "start", toBoundary: "start", mode: "exact", approximate: false, reason: "Arrive three hours before departure." },
    ],
    blockedTimes: [], globalInstructions: [], ignoredStatements: [],
  });
  const tasks = validateAndDedupeExtraction(compileSemanticDraft({ text, currentLocalDate: "2026-09-05", timeZone }, draft)).tasks;
  // Previously saved v0.1.7 links remain readable. New extraction intentionally
  // does not create them, so this legacy-persistence fixture supplies them.
  tasks[1] = { ...tasks[1], taskType: "flexible", responsibilityKind: "milestone", dueAt: tasks[1].fixedStartAt, dueDate: "2026-09-09", dueTime: "15:00", fixedStartAt: undefined, fixedEndAt: undefined, estimatedMinutes: undefined, minimumSessionMinutes: undefined };
  tasks[0].schedulingConstraints = { linkedTiming: { rules: [{ taskId: "arrival", boundary: "end", targetBoundary: "start", offsetMinutes: 0, mode: "exact", approximate: false }], approximate: true, durationEstimated: true, arrivalBuffer: false, unresolved: false } };
  tasks[1].schedulingConstraints = { linkedTiming: { rules: [{ taskId: "flight", boundary: "start", targetBoundary: "start", offsetMinutes: -180, mode: "exact", approximate: false }], approximate: false, durationEstimated: false, arrivalBuffer: true, unresolved: false } };
  tasks[0].dependencies = [{ taskId: "arrival", relation: "before", minimumGapMinutes: 0, maximumLagMinutes: 0 }];
  tasks[1].dependencies = [{ taskId: "flight", relation: "before", minimumGapMinutes: 180 }];
  return tasks;
}
const confirmed = (tasks: ExtractedTask[]): ExtractedTask[] => tasks.map((task) => ({ ...task, approved: true, reviewRequired: false, missingInformation: [] }));
const schedule = (tasks: ExtractedTask[]) => generateSchedule({ tasks, preferences: { ...TEST_PREFERENCES, timeZone }, windowStart: "2026-09-09T07:00:00Z", windowEnd: "2026-09-10T07:00:00Z", availability: [{ start: "2026-09-09T14:00:00Z", end: "2026-09-10T06:00:00Z" }], unavailableEvents: [], blockedTimes: [], lockedSessions: [] });

describe("compatibility with previously saved linked fixed-time proposals", () => {
  it("creates ordinary fixed travel, a zero-work arrival, and a separate reserved buffer", () => {
    const tasks = airport();
    expect(tasks[0]).toMatchObject({ taskType: "fixed_time", estimatedMinutes: 30, reviewRequired: true, schedulingConstraints: { linkedTiming: { approximate: true, durationEstimated: true, unresolved: false } } });
    expect(clock(tasks[0].fixedStartAt)).toBe("2026-09-09 14:30");
    expect(clock(tasks[0].fixedEndAt)).toBe("2026-09-09 15:00");
    expect(clock(tasks[1].dueAt)).toBe("2026-09-09 15:00");
    expect(tasks[1].estimatedMinutes).toBeUndefined();
    expect(clock(tasks[2].fixedStartAt)).toBe("2026-09-09 18:00");
    expect(clock(tasks[2].fixedEndAt)).toBe("2026-09-09 21:00");
    expect(arrivalBufferReservations(tasks)).toEqual([]);
    const [buffer] = arrivalBufferReservations(tasks, true);
    expect(clock(buffer.start)).toBe("2026-09-09 15:00");
    expect(clock(buffer.end)).toBe("2026-09-09 18:00");
  });

  it("recalculates the full chain across both a date and a time edit", () => {
    const tasks = applyLinkedTaskEdit(confirmed(airport()), "flight", { fixedStartAt: "2026-09-11T03:00:00Z" }, timeZone);
    expect(clock(tasks[2].fixedStartAt)).toBe("2026-09-10 20:00");
    expect(clock(tasks[2].fixedEndAt)).toBe("2026-09-10 23:00");
    expect(clock(tasks[1].dueAt)).toBe("2026-09-10 17:00");
    expect(clock(tasks[0].fixedStartAt)).toBe("2026-09-10 16:30");
    expect(clock(tasks[0].fixedEndAt)).toBe("2026-09-10 17:00");
    expect(tasks[0].reviewRequired).toBe(true);
    expect(tasks[1].reviewRequired).toBe(true);
    expect(Date.parse(arrivalBufferReservations(tasks, true)[0].end)).toBe(Date.parse(tasks[2].fixedStartAt!));
  });

  it("recalculates backwards through midnight without changing the flight's duration", () => {
    const tasks = applyLinkedTaskEdit(airport(), "flight", { fixedStartAt: "2026-09-09T08:00:00Z" }, timeZone);
    expect(clock(tasks[2].fixedEndAt)).toBe("2026-09-09 04:00");
    expect(clock(tasks[1].dueAt)).toBe("2026-09-08 22:00");
    expect(clock(tasks[0].fixedStartAt)).toBe("2026-09-08 21:30");
  });

  it("edits travel duration without moving its required arrival", () => {
    const tasks = applyLinkedTaskEdit(airport(), "drive", { estimatedMinutes: 45 }, timeZone);
    expect(clock(tasks[0].fixedStartAt)).toBe("2026-09-09 14:15");
    expect(clock(tasks[0].fixedEndAt)).toBe("2026-09-09 15:00");
    expect(tasks[0].schedulingConstraints?.linkedTiming?.durationEstimated).toBe(false);
  });

  it("does not undo an explicit override of a linked card's own clock", () => {
    const overridden = applyLinkedTaskEdit(airport(), "drive", { fixedStartAt: "2026-09-09T21:00:00Z" }, timeZone);
    expect(overridden[0].schedulingConstraints?.linkedTiming).toBeUndefined();
    expect(overridden[0].dependencies).toEqual([]);
    const moved = applyLinkedTaskEdit(overridden, "flight", { fixedStartAt: "2026-09-10T03:00:00Z" }, timeZone);
    expect(clock(moved[0].fixedStartAt)).toBe("2026-09-09 14:00");
    expect(clock(moved[1].dueAt)).toBe("2026-09-09 17:00");
  });

  it.each(["missing", "cancelled", "cleared"])("keeps a %s anchor from leaving silently schedulable stale travel", (state) => {
    let tasks = confirmed(airport());
    if (state === "missing") tasks = tasks.filter((task) => task.id !== "flight");
    if (state === "cancelled") tasks[2].cancelled = true;
    if (state === "cleared") { tasks[2].fixedStartAt = undefined; tasks[2].fixedEndAt = undefined; }
    tasks = recalculateLinkedTiming(tasks, timeZone);
    expect(tasks[0].reviewRequired).toBe(true);
    expect(tasks[0].schedulingConstraints?.linkedTiming?.unresolved).toBe(true);
    expect(tasks[1].schedulingConstraints?.linkedTiming?.unresolved).toBe(true);
    expect(arrivalBufferReservations(tasks, true)).toEqual([]);
    expect(schedule(tasks).sessions.some((session) => session.taskId === "drive")).toBe(false);
  });

  it("detects cycles and keeps all affected proposals under review", () => {
    const tasks = confirmed(airport());
    tasks[1].schedulingConstraints!.linkedTiming!.rules[0].taskId = "drive";
    const result = recalculateLinkedTiming(tasks, timeZone);
    expect(result[0].schedulingConstraints?.linkedTiming?.unresolved).toBe(true);
    expect(result[1].schedulingConstraints?.linkedTiming?.unresolved).toBe(true);
  });

  it("reserves the arrival buffer after review without counting it as active work", () => {
    const tasks = confirmed(airport());
    const extra = task({ id: "reading", title: "Read", estimatedMinutes: 60, splittable: false });
    const proposal = schedule([...tasks, extra]);
    expect(proposal.unschedulable).toEqual([]);
    expect(proposal.sessions.filter((session) => session.taskId === "drive")).toHaveLength(1);
    expect(proposal.sessions.some((session) => session.taskId === "arrival")).toBe(false);
    const [buffer] = arrivalBufferReservations(tasks);
    expect(proposal.sessions.some((session) => Date.parse(session.start) < Date.parse(buffer.end) && Date.parse(session.end) > Date.parse(buffer.start))).toBe(false);
    expect(proposal.sessions.reduce((sum, session) => sum + session.minutes, 0)).toBe(270);
  });

  it("round-trips links through workspace validation and the existing JSON database field", () => {
    const tasks = airport();
    const saved = parsePersistedWorkspace(JSON.parse(JSON.stringify({ version: 1, tasks, proposal: schedule(tasks), importText: "", history: [], sessionReviews: [], planningMode: "balanced" })));
    expect(saved.tasks[0].schedulingConstraints?.linkedTiming).toEqual(tasks[0].schedulingConstraints?.linkedTiming);
    expect(toSupabaseTaskRow("user", "source", tasks[0], null).scheduling_constraints?.linkedTiming).toEqual(tasks[0].schedulingConstraints?.linkedTiming);
    const updated = applyLinkedTaskEdit(saved.tasks, "flight", { fixedStartAt: "2026-09-10T02:00:00Z" }, timeZone);
    expect(clock(updated[0].fixedStartAt)).toBe("2026-09-09 15:30");
  });

  it("remaps links on reimport and after colliding provider IDs", () => {
    const incoming = airport();
    const existingFlight = { ...incoming[2], id: "saved-flight" };
    const unrelated = task({ id: "drive", title: "Unrelated task" });
    const merged = mergeImportedTasks([existingFlight, unrelated], incoming, () => "new-drive");
    const arrival = merged.tasks.find((task) => task.id === "arrival")!;
    expect(arrival.schedulingConstraints?.linkedTiming?.rules[0].taskId).toBe("saved-flight");
    expect(arrival.dependencies?.[0].taskId).toBe("saved-flight");
    expect(merged.tasks.find((task) => task.id === "new-drive")?.schedulingConstraints?.linkedTiming?.rules[0].taskId).toBe("arrival");
    const updated = applyLinkedTaskEdit(merged.tasks, "saved-flight", { fixedStartAt: "2026-09-10T02:00:00Z" }, timeZone);
    expect(clock(updated.find((task) => task.id === "new-drive")?.fixedStartAt)).toBe("2026-09-09 15:30");
  });

  it("rejects invalid persisted arithmetic", () => {
    const original = airport()[0];
    for (const offsetMinutes of [Infinity, 0.5, 100_000]) {
      const changed = structuredClone(original);
      changed.schedulingConstraints!.linkedTiming!.rules[0].offsetMinutes = offsetMinutes;
      expect(extractedTaskSchema.safeParse(changed).success).toBe(false);
    }
  });

  it("upgrades an old approximate travel window on reimport without adding duplicates", () => {
    const fresh = airport();
    const old = structuredClone(fresh);
    old[0].taskType = "flexible";
    old[0].fixedStartAt = undefined;
    old[0].fixedEndAt = undefined;
    old.forEach((task) => { if (task.schedulingConstraints) delete task.schedulingConstraints.linkedTiming; });
    const merged = mergeImportedTasks(old, fresh);
    expect(merged.tasks).toHaveLength(3);
    expect(merged.tasks[0].taskType).toBe("fixed_time");
    expect(merged.tasks[0].schedulingConstraints?.linkedTiming).toBeDefined();
    expect(merged.tasks[1].schedulingConstraints?.linkedTiming).toBeDefined();
  });

  it("keeps a direct clock override independent of old calculated planning bounds", () => {
    const tasks = applyLinkedTaskEdit(airport(), "drive", { fixedStartAt: "2026-09-10T02:00:00Z" }, timeZone);
    expect(tasks[0].schedulingConstraints?.allowedDateWindows).toBeUndefined();
    expect(tasks[0].schedulingConstraints?.linkedTiming).toBeUndefined();
  });
});
