import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { dateOnlyPlanningDeadline } from "./date-interpretation";
import { taskSequence } from "./task-sequence";
import type { ExtractedTask, PlannedSession, ScheduledBreak } from "./types";

const MINUTE = 60_000;

export type ManualDeadlineUpdate = {
  dueDate: string;
  dueTime?: string;
};

export function manualPlacementStart(
  date: string,
  time: string,
  timeZone: string,
): string {
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !timeMatch ||
    Number(timeMatch[1]) > 23 ||
    Number(timeMatch[2]) > 59
  ) {
    throw new Error("Choose a valid placement date and time.");
  }
  const instant = fromZonedTime(`${date}T${time}:00`, timeZone);
  if (
    !Number.isFinite(instant.getTime()) ||
    formatInTimeZone(instant, timeZone, "yyyy-MM-dd'T'HH:mm") !==
      `${date}T${time}`
  ) {
    throw new Error("Choose a valid placement date and time.");
  }
  return instant.toISOString();
}

export function manualPlacementEnd(
  start: string,
  minutes: number,
): string {
  const startAt = new Date(start).getTime();
  if (!Number.isFinite(startAt) || !Number.isFinite(minutes) || minutes <= 0) {
    throw new Error("The session needs a valid start time and duration.");
  }
  return new Date(startAt + Math.round(minutes) * MINUTE).toISOString();
}

export function taskDeadlineInstant(
  task: ExtractedTask,
  timeZone: string,
  sleepingTime: string,
): string | undefined {
  if (task.dueAt && Number.isFinite(new Date(task.dueAt).getTime())) {
    return new Date(task.dueAt).toISOString();
  }
  if (task.dueDate) {
    if (task.dueTime) {
      return manualPlacementStart(task.dueDate, task.dueTime, timeZone);
    }
    return dateOnlyPlanningDeadline(task.dueDate, sleepingTime, timeZone);
  }
  if (
    task.recurrence?.windowEnd &&
    Number.isFinite(new Date(task.recurrence.windowEnd).getTime())
  ) {
    return new Date(task.recurrence.windowEnd).toISOString();
  }
  return undefined;
}

export function isManualPlacementAfterDeadline(
  task: ExtractedTask | undefined,
  sessionEnd: string,
  timeZone: string,
  sleepingTime: string,
): boolean {
  if (!task) return false;
  const deadline = taskDeadlineInstant(task, timeZone, sleepingTime);
  if (!deadline) return false;
  return new Date(sessionEnd).getTime() > new Date(deadline).getTime();
}

export function deadlineUpdateFields(
  update: ManualDeadlineUpdate,
  timeZone: string,
): Pick<ExtractedTask, "dueDate" | "dueTime" | "dueAt"> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(update.dueDate)) {
    throw new Error("Choose a valid deadline date.");
  }
  return {
    dueDate: update.dueDate,
    dueTime: update.dueTime || undefined,
    dueAt: update.dueTime
      ? manualPlacementStart(update.dueDate, update.dueTime, timeZone)
      : undefined,
  };
}

export function manuallyPlacedSession(
  session: PlannedSession,
  start: string,
): PlannedSession {
  const duration = Math.max(
    MINUTE,
    new Date(session.end).getTime() - new Date(session.start).getTime(),
  );
  const startAt = new Date(start).getTime();
  if (!Number.isFinite(startAt)) {
    throw new Error("Choose a valid placement date and time.");
  }
  return {
    ...session,
    start: new Date(startAt).toISOString(),
    end: new Date(startAt + duration).toISOString(),
    locked: true,
    reviewAfter: undefined,
    reasonCodes: ["USER_PLACEMENT"],
    explanation:
      "Locked at the date and time you chose. Flexible work will be scheduled around this decision.",
  };
}

export function manuallyPlacedBreak(
  session: PlannedSession,
  previousBreak: ScheduledBreak | undefined,
  fallbackMinutes = 0,
): ScheduledBreak | undefined {
  const minutes = previousBreak?.minutes ?? fallbackMinutes;
  if (minutes <= 0) return undefined;
  const start = new Date(session.end).getTime();
  return {
    afterSessionId: session.id,
    start: new Date(start).toISOString(),
    end: new Date(start + minutes * MINUTE).toISOString(),
    minutes,
  };
}

function intervalsOverlap(
  firstStart: string,
  firstEnd: string,
  secondStart: string,
  secondEnd: string,
): boolean {
  return (
    new Date(firstStart).getTime() < new Date(secondEnd).getTime() &&
    new Date(secondStart).getTime() < new Date(firstEnd).getTime()
  );
}

export function sessionsForManualPlacementReflow(
  sessions: PlannedSession[],
  tasks: ExtractedTask[],
  moved: PlannedSession,
  protectedUntil = moved.end,
): PlannedSession[] {
  const tasksById = new Map(
    tasks.map((task) => [task.id ?? task.title, task]),
  );
  const movedTask = tasksById.get(moved.taskId);
  const movedSequenceGroup = movedTask
    ? taskSequence(movedTask)?.groupId
    : undefined;
  return sessions.flatMap((session) => {
    if (session.id === moved.id) return [moved];
    const task = tasksById.get(session.taskId);
    const mustStay =
      session.locked ||
      session.status !== "proposed" ||
      !task ||
      task.taskType === "fixed_time" ||
      task.recurrence?.mode === "fixed_times";
    if (mustStay) return [session];
    const isRelated =
      session.taskId === moved.taskId ||
      (movedSequenceGroup !== undefined &&
        taskSequence(task)?.groupId === movedSequenceGroup);
    if (isRelated) return [];
    return intervalsOverlap(
      session.start,
      session.end,
      moved.start,
      protectedUntil,
    )
      ? []
      : [session];
  });
}

export function intervalOverlapsManualPlacement(
  start: string,
  end: string,
  moved: PlannedSession,
  protectedUntil = moved.end,
): boolean {
  return intervalsOverlap(start, end, moved.start, protectedUntil);
}
