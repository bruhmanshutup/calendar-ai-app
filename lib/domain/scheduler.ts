import {
  addDays,
  differenceInCalendarDays,
  differenceInCalendarMonths,
  differenceInCalendarWeeks,
  format,
  parseISO,
} from "date-fns";
import { fromZonedTime } from "date-fns-tz";
import {
  PLANNING_MODE_CONFIG,
  PRIORITY_WEIGHT,
  SCHEDULER_INCREMENT_MINUTES,
} from "./config";
import { dateOnlyPlanningDeadline } from "./date-interpretation";
import { explainReasons } from "./explanations";
import { arrivalBufferReservations } from "./linked-timing";
import { isCalculatedFixedTime, materializeCalculatedTimeBlock } from "./calculated-time-block";
import { recurrenceTimesForDay } from "./recurrence";
import {
  sequenceTargetDate,
  taskSequence,
  type TaskSequenceDescriptor,
} from "./task-sequence";
import type {
  DayOfWeek,
  ExtractedTask,
  PlannedSession,
  ScheduleProposal,
  ScheduleReasonCode,
  ScheduledBreak,
  SchedulingInput,
  TemporalWindow,
  TimeInterval,
  UnschedulableTask,
} from "./types";

const MINUTE = 60_000;
const zonedClockCache = new Map<string, number>();
const ZONED_CLOCK_CACHE_LIMIT = 20_000;

type NumericInterval = { start: number; end: number };

type Candidate = {
  start: number;
  end: number;
  minutes: number;
  localDate: string;
  adjacentTaskDay?: boolean;
  score: number;
  reasons: ScheduleReasonCode[];
};

type SequenceProgress = {
  blocked: boolean;
  lastDate?: string;
};

type ResolvedDependencyEdge = {
  predecessorId: string;
  successorId: string;
  strength: "hard" | "soft";
  minimumGapMinutes: number;
  maximumLagMinutes?: number;
};

type DependencyPlan = {
  edges: ResolvedDependencyEdge[];
  unresolvedHardTaskIds: Set<string>;
  cycleBlockedTaskIds: Set<string>;
  externalResolvedTaskIds: Set<string>;
};

type TimedOccurrence = NumericInterval & { date: string; time: string };

type LocalParts = { date: string; minutes: number; weekday: string };

type CandidateDayLoad = {
  sessionCount: number;
  minutes: number;
  taskOccurrences: number;
};

type ConditionalDurationRule = {
  nextDayAssessment: true;
  minutes: number;
};

type ConditionalDurationContext = {
  assessmentDates: Set<string>;
  rulesByTaskId: Map<string, ConditionalDurationRule[]>;
};

const LOCAL_PARTS_CACHE_LIMIT = 20_000;
const localPartsCache = new Map<string, LocalParts>();
const localPartsFormatters = new Map<string, Intl.DateTimeFormat>();

function toNumeric(interval: TimeInterval): NumericInterval {
  return {
    start: new Date(interval.start).getTime(),
    end: new Date(interval.end).getTime(),
  };
}

function intervalMinutes(interval: NumericInterval): number {
  return Math.max(0, Math.round((interval.end - interval.start) / MINUTE));
}

function mergeIntervals(intervals: NumericInterval[]): NumericInterval[] {
  const ordered = intervals
    .filter(
      (interval) =>
        Number.isFinite(interval.start) &&
        Number.isFinite(interval.end) &&
        interval.end > interval.start,
    )
    .sort((first, second) => first.start - second.start || first.end - second.end);
  const merged: NumericInterval[] = [];
  for (const interval of ordered) {
    const previous = merged.at(-1);
    if (!previous || interval.start > previous.end) {
      merged.push({ ...interval });
      continue;
    }
    previous.end = Math.max(previous.end, interval.end);
  }
  return merged;
}

function occupiedMinutesWithin(
  boundary: NumericInterval,
  busy: NumericInterval[],
): number {
  const clipped = busy
    .map((event) => ({
      start: Math.max(boundary.start, event.start),
      end: Math.min(boundary.end, event.end),
    }))
    .filter((event) => event.end > event.start);
  return mergeIntervals(clipped).reduce(
    (total, interval) => total + intervalMinutes(interval),
    0,
  );
}

function sessionMinutes(start: string, end: string): number {
  return intervalMinutes({
    start: new Date(start).getTime(),
    end: new Date(end).getTime(),
  });
}

function committedMinutesForTask(
  taskId: string,
  input: SchedulingInput,
): number {
  return input.lockedSessions.reduce((total, session) => {
    if (
      session.taskId !== taskId ||
      !["proposed", "approved"].includes(session.status)
    ) {
      return total;
    }
    return total + sessionMinutes(session.start, session.end);
  }, 0);
}

function hasMatchingLockedSession(
  taskId: string,
  start: number,
  end: number,
  input: SchedulingInput,
): boolean {
  return input.lockedSessions.some(
    (session) =>
      session.taskId === taskId &&
      new Date(session.start).getTime() === start &&
      new Date(session.end).getTime() === end,
  );
}

function uniqueSessionId(base: string, sessions: PlannedSession[]): string {
  if (!sessions.some((session) => session.id === base)) return base;
  let version = 2;
  while (sessions.some((session) => session.id === `${base}-v${version}`)) {
    version += 1;
  }
  return `${base}-v${version}`;
}

function isInside(
  candidate: NumericInterval,
  availability: NumericInterval[],
): boolean {
  return availability.some(
    (interval) =>
      candidate.start >= interval.start && candidate.end <= interval.end,
  );
}

function explicitTimeIsAllowed(
  candidate: NumericInterval,
  input: SchedulingInput,
  availability: NumericInterval[],
): boolean {
  if (isInside(candidate, availability)) return true;
  if (!input.allowExplicitTimesOutsideAvailability) return false;
  return (
    candidate.start >= new Date(input.windowStart).getTime() &&
    candidate.end <= new Date(input.windowEnd).getTime()
  );
}

function isFree(
  candidate: NumericInterval,
  busy: NumericInterval[],
): boolean {
  let low = 0;
  let high = busy.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (busy[middle].end <= candidate.start) low = middle + 1;
    else high = middle;
  }
  return low >= busy.length || busy[low].start >= candidate.end;
}

function overlaps(left: NumericInterval, right: NumericInterval): boolean {
  return left.start < right.end && right.start < left.end;
}

function isFixedTask(task: ExtractedTask | undefined): boolean {
  return task?.taskType === "fixed_time" || task?.recurrence?.mode === "fixed_times";
}

function insertBusyInterval(
  busy: NumericInterval[],
  interval: NumericInterval,
): void {
  let low = 0;
  let high = busy.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (busy[middle].end < interval.start) low = middle + 1;
    else high = middle;
  }
  const first = low;
  let end = interval.end;
  let last = first;
  while (last < busy.length && busy[last].start <= end) {
    end = Math.max(end, busy[last].end);
    last += 1;
  }
  busy.splice(first, last - first, {
    start: Math.min(interval.start, busy[first]?.start ?? interval.start),
    end,
  });
}

function ceilToIncrement(value: number): number {
  const increment = SCHEDULER_INCREMENT_MINUTES * MINUTE;
  return Math.ceil(value / increment) * increment;
}

function floorToIncrement(value: number): number {
  const increment = SCHEDULER_INCREMENT_MINUTES * MINUTE;
  return Math.floor(value / increment) * increment;
}

function zonedClockInstant(date: string, time: string, timeZone: string): number {
  const key = `${timeZone}:${date}:${time}`;
  const cached = zonedClockCache.get(key);
  if (cached !== undefined) return cached;
  const instant = fromZonedTime(`${date}T${time}:00`, timeZone).getTime();
  if (zonedClockCache.size >= ZONED_CLOCK_CACHE_LIMIT) zonedClockCache.clear();
  zonedClockCache.set(key, instant);
  return instant;
}

function* denseCandidateStarts(
  start: number,
  lastStart: number,
): Generator<number> {
  const increment = SCHEDULER_INCREMENT_MINUTES * MINUTE;
  for (let candidate = start; candidate <= lastStart; candidate += increment) {
    yield candidate;
  }
}

function localParts(
  instant: number,
  timeZone: string,
): LocalParts {
  const cacheKey = `${timeZone}:${instant}`;
  const cached = localPartsCache.get(cacheKey);
  if (cached) return cached;

  let formatter = localPartsFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    localPartsFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(instant));
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  const result = {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    minutes: Number(value("hour")) * 60 + Number(value("minute")),
    weekday: value("weekday").toLocaleLowerCase(),
  };
  if (localPartsCache.size >= LOCAL_PARTS_CACHE_LIMIT) localPartsCache.clear();
  localPartsCache.set(cacheKey, result);
  return result;
}

function calendarDistance(
  frequency: NonNullable<ExtractedTask["recurrence"]>["frequency"],
  left: string,
  right: string,
): number {
  const leftDate = parseISO(left);
  const rightDate = parseISO(right);
  if (frequency === "weekly") {
    return Math.abs(
      differenceInCalendarWeeks(leftDate, rightDate, { weekStartsOn: 1 }),
    );
  }
  if (frequency === "monthly") {
    return Math.abs(differenceInCalendarMonths(leftDate, rightDate));
  }
  return Math.abs(differenceInCalendarDays(leftDate, rightDate));
}

function quotaRecurrenceAllowsDate(
  task: ExtractedTask,
  candidateDate: string,
  candidateWeekday: DayOfWeek,
  taskSessions: PlannedSession[],
  timeZone: string,
): boolean {
  const recurrence = task.recurrence;
  if (task.taskType !== "recurring_goal" || !recurrence) return true;
  if (
    recurrence.mode === "quota" &&
    recurrence.daysOfWeek?.length &&
    !recurrence.daysOfWeek.includes(candidateWeekday)
  ) {
    return false;
  }

  const interval = Math.max(1, recurrence.interval ?? 1);
  if (recurrence.anchorDate && interval > 1) {
    const candidate = parseISO(candidateDate);
    const anchor = parseISO(recurrence.anchorDate);
    const signedDistance =
      recurrence.frequency === "weekly"
        ? differenceInCalendarWeeks(candidate, anchor, { weekStartsOn: 1 })
        : recurrence.frequency === "monthly"
          ? differenceInCalendarMonths(candidate, anchor)
          : differenceInCalendarDays(candidate, anchor);
    if (signedDistance < 0 || signedDistance % interval !== 0) return false;
  }

  return taskSessions.every((session) => {
    const sessionDate = localParts(
      new Date(session.start).getTime(),
      timeZone,
    ).date;
    if (sessionDate === candidateDate) return false;
    if (interval <= 1) return true;
    return (
      calendarDistance(recurrence.frequency, candidateDate, sessionDate) >=
      interval
    );
  });
}

function clockMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function wakingEdgePenalty(
  localMinutes: number,
  durationMinutes: number,
  wakingTime: string,
  sleepingTime: string,
): number {
  const wake = clockMinutes(wakingTime);
  let sleep = clockMinutes(sleepingTime);
  if (sleep <= wake) sleep += 24 * 60;
  const candidate = localMinutes < wake ? localMinutes + 24 * 60 : localMinutes;
  const minutesSinceWake = candidate - wake;
  const minutesUntilSleep = sleep - (candidate + durationMinutes);
  const earlyPenalty = Math.max(0, 60 - minutesSinceWake) * 0.2;
  const latePenalty = Math.max(0, 180 - minutesUntilSleep) * 0.35;
  return earlyPenalty + latePenalty;
}

function isInClockWindow(
  value: number,
  window: { start: string; end: string },
): boolean {
  const start = clockMinutes(window.start);
  const end = clockMinutes(window.end);
  return start <= end
    ? value >= start && value < end
    : value >= start || value < end;
}

function sessionFitsClockWindow(
  startMinutes: number,
  durationMinutes: number,
  window: { start: string; end: string },
): boolean {
  const windowStart = clockMinutes(window.start);
  const rawEnd = clockMinutes(window.end);
  const windowEnd = rawEnd <= windowStart ? rawEnd + 24 * 60 : rawEnd;
  const candidateStart =
    startMinutes < windowStart && windowEnd > 24 * 60
      ? startMinutes + 24 * 60
      : startMinutes;
  return (
    candidateStart >= windowStart &&
    candidateStart + durationMinutes <= windowEnd
  );
}

function isWithinWakingHours(
  instant: number,
  wakingTime: string,
  sleepingTime: string,
  timeZone: string,
): boolean {
  return isInClockWindow(localParts(instant, timeZone).minutes, {
    start: wakingTime,
    end: sleepingTime,
  });
}

function statedTaskDeadline(
  task: ExtractedTask,
  input: SchedulingInput,
): number {
  if (task.dueAt) return new Date(task.dueAt).getTime();
  if (task.dueWindow?.start) {
    return new Date(task.dueWindow.start).getTime();
  }
  if (task.dueDate) {
    return new Date(
      dateOnlyPlanningDeadline(
        task.dueDate,
        input.preferences.sleepingTime,
        input.preferences.timeZone,
      ),
    ).getTime();
  }
  if (task.recurrence?.windowEnd) {
    return new Date(task.recurrence.windowEnd).getTime();
  }
  return new Date(input.windowEnd).getTime();
}

function isOverdueTask(task: ExtractedTask, input: SchedulingInput): boolean {
  if (!task.dueAt && !task.dueWindow && !task.dueDate) return false;
  return statedTaskDeadline(task, input) < new Date(input.windowStart).getTime();
}

function taskDeadline(task: ExtractedTask, input: SchedulingInput): number {
  return isOverdueTask(task, input)
    ? new Date(input.windowEnd).getTime()
    : statedTaskDeadline(task, input);
}

function availableCapacityBefore(
  deadline: number,
  availability: NumericInterval[],
  busy: NumericInterval[],
): number {
  return availability.reduce((total, interval) => {
    const clipped: NumericInterval = {
      start: interval.start,
      end: Math.min(interval.end, deadline),
    };
    if (clipped.end <= clipped.start) return total;
    const occupied = occupiedMinutesWithin(clipped, busy);
    return total + Math.max(0, intervalMinutes(clipped) - occupied);
  }, 0);
}

function taskRisk(
  task: ExtractedTask,
  input: SchedulingInput,
  availability: NumericInterval[],
  busy: NumericInterval[],
): number {
  const minutes = task.estimatedMinutes ?? 0;
  if (
    task.taskType === "fixed_time" ||
    task.recurrence?.mode === "fixed_times"
  ) {
    return 2_000_000 + minutes + PRIORITY_WEIGHT[task.priority];
  }
  if (isOverdueTask(task, input)) {
    return 100_000 + minutes + PRIORITY_WEIGHT[task.priority];
  }
  const deadline = taskDeadline(task, input);
  const capacity = Math.max(
    1,
    availableCapacityBefore(deadline, availability, busy),
  );
  const hoursRemaining = Math.max(
    0.25,
    (deadline - new Date(input.windowStart).getTime()) / (60 * MINUTE),
  );
  return (
    (minutes / capacity) * 120 +
    80 / hoursRemaining +
    PRIORITY_WEIGHT[task.priority]
  );
}

function buildDependencyPlan(
  tasks: ExtractedTask[],
  lockedSessions: SchedulingInput["lockedSessions"],
): DependencyPlan {
  const taskIds = new Set(
    tasks.flatMap((task) => (task.id ? [task.id] : [])),
  );
  const externalResolvedTaskIds = new Set(
    lockedSessions
      .map((session) => session.taskId)
      .filter((taskId) => !taskIds.has(taskId)),
  );
  const resolvableTaskIds = new Set([
    ...taskIds,
    ...externalResolvedTaskIds,
  ]);
  const edges: ResolvedDependencyEdge[] = [];
  const unresolvedHardTaskIds = new Set<string>();

  for (const task of tasks) {
    if (!task.id) continue;
    // Review-only relationships are proposals, not active scheduling constraints.
    if (task.reviewRequired) continue;
    for (const dependency of task.dependencies ?? []) {
      if (dependency.strength !== "hard" && dependency.strength !== "soft") {
        continue;
      }
      if (!dependency.taskId || !resolvableTaskIds.has(dependency.taskId)) {
        if (dependency.strength === "hard") {
          unresolvedHardTaskIds.add(task.id);
        }
        continue;
      }
      edges.push({
        predecessorId:
          dependency.relation === "before" ? task.id : dependency.taskId,
        successorId:
          dependency.relation === "before" ? dependency.taskId : task.id,
        strength: dependency.strength,
        minimumGapMinutes: dependency.minimumGapMinutes ?? 0,
        ...(dependency.maximumLagMinutes !== undefined
          ? { maximumLagMinutes: dependency.maximumLagMinutes }
          : {}),
      });
    }
  }

  const indegree = new Map(
    [...resolvableTaskIds].map((taskId) => [taskId, 0]),
  );
  const following = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.strength !== "hard") continue;
    indegree.set(edge.successorId, (indegree.get(edge.successorId) ?? 0) + 1);
    const successors = following.get(edge.predecessorId) ?? [];
    successors.push(edge.successorId);
    following.set(edge.predecessorId, successors);
  }
  const ready = [...resolvableTaskIds].filter(
    (taskId) => indegree.get(taskId) === 0,
  );
  const resolved = new Set<string>();
  while (ready.length > 0) {
    const taskId = ready.shift();
    if (!taskId) break;
    resolved.add(taskId);
    for (const successorId of following.get(taskId) ?? []) {
      const remaining = (indegree.get(successorId) ?? 0) - 1;
      indegree.set(successorId, remaining);
      if (remaining === 0) ready.push(successorId);
    }
  }

  return {
    edges,
    unresolvedHardTaskIds,
    cycleBlockedTaskIds: new Set(
      [...taskIds].filter((taskId) => !resolved.has(taskId)),
    ),
    externalResolvedTaskIds,
  };
}

function tasksInSchedulingOrder(
  tasks: ExtractedTask[],
  input: SchedulingInput,
  availability: NumericInterval[],
  busy: NumericInterval[],
  dependencyPlan: DependencyPlan,
): ExtractedTask[] {
  const riskByTask = new Map(
    tasks.map((task) => [task, taskRisk(task, input, availability, busy)]),
  );
  const standalone: ExtractedTask[] = [];
  const sequenceGroups = new Map<
    string,
    Array<{ task: ExtractedTask; sequence: TaskSequenceDescriptor }>
  >();

  tasks.forEach((task) => {
    const sequence = taskSequence(task);
    if (!sequence) {
      standalone.push(task);
      return;
    }
    const group = sequenceGroups.get(sequence.groupId) ?? [];
    group.push({ task, sequence });
    sequenceGroups.set(sequence.groupId, group);
  });
  sequenceGroups.forEach((group) =>
    group.sort(
      (first, second) =>
        first.sequence.order - second.sequence.order ||
        (first.task.id ?? "").localeCompare(second.task.id ?? ""),
    ),
  );

  const ready: Array<{ task: ExtractedTask; groupId?: string }> = [
    ...standalone.map((task) => ({ task })),
    ...[...sequenceGroups.entries()].flatMap(([groupId, group]) => {
      const next = group.shift();
      return next ? [{ task: next.task, groupId }] : [];
    }),
  ];
  const ordered: ExtractedTask[] = [];
  const orderedIds = new Set(dependencyPlan.externalResolvedTaskIds);
  while (ready.length > 0) {
    const eligible = ready.filter(({ task }) => {
      if (!task.id || dependencyPlan.cycleBlockedTaskIds.has(task.id)) {
        return false;
      }
      return dependencyPlan.edges.every(
        (edge) =>
          edge.strength !== "hard" ||
          edge.successorId !== task.id ||
          orderedIds.has(edge.predecessorId),
      );
    });
    const candidates = eligible.length > 0 ? eligible : ready;
    candidates.sort(
      (first, second) =>
        (riskByTask.get(second.task) ?? 0) -
          (riskByTask.get(first.task) ?? 0) ||
        (first.task.id ?? "").localeCompare(second.task.id ?? ""),
    );
    const next = candidates[0];
    if (!next) break;
    ready.splice(ready.indexOf(next), 1);
    ordered.push(next.task);
    if (next.task.id) orderedIds.add(next.task.id);
    if (!next.groupId) continue;
    const following = sequenceGroups.get(next.groupId)?.shift();
    if (following) ready.push({ task: following.task, groupId: next.groupId });
  }
  return ordered;
}

function sequenceEarliestStart(
  sequence: TaskSequenceDescriptor,
  progress: SequenceProgress,
  input: SchedulingInput,
): number {
  const windowStart = new Date(input.windowStart).getTime();
  const fallbackAnchor = localParts(
    windowStart,
    input.preferences.timeZone,
  ).date;
  let earliestDate = sequenceTargetDate(sequence, fallbackAnchor);
  if (progress.lastDate) {
    const afterPredecessor = format(
      addDays(parseISO(progress.lastDate), sequence.minimumGapDays),
      "yyyy-MM-dd",
    );
    if (afterPredecessor > earliestDate) earliestDate = afterPredecessor;
  }
  return Math.max(
    windowStart,
    fromZonedTime(
      `${earliestDate}T00:00:00`,
      input.preferences.timeZone,
    ).getTime(),
  );
}

function updateSequenceProgress(
  progress: SequenceProgress,
  task: ExtractedTask,
  sessions: PlannedSession[],
  input: SchedulingInput,
): void {
  const taskId = task.id ?? task.title;
  const latestDate = sessions
    .filter((session) => session.taskId === taskId)
    .map((session) =>
      localParts(
        new Date(session.start).getTime(),
        input.preferences.timeZone,
      ).date,
    )
    .sort()
    .at(-1);
  const fallbackDate = localParts(
    new Date(input.windowStart).getTime(),
    input.preferences.timeZone,
  ).date;
  const completedDate = latestDate ?? fallbackDate;
  if (!progress.lastDate || completedDate > progress.lastDate) {
    progress.lastDate = completedDate;
  }
}

const ASSESSMENT_NOUN = /\b(?:exam(?:ination)?|quiz|test|midterm|final)\b/i;
const ASSESSMENT_PREPARATION =
  /\b(?:study|review|prepare|preparation|prep|practice|revise|revision|work on)\b/i;

function durationMinutesInEffect(effect: string): number | undefined {
  const match = effect.match(
    /\b(\d+(?:\.\d+)?)\s*-?\s*(minutes?|mins?|hours?|hrs?)\b/i,
  );
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const minutes = /^(?:hours?|hrs?)$/i.test(match[2])
    ? amount * 60
    : amount;
  const rounded = Math.round(minutes);
  return rounded > 0 && rounded <= 24 * 60 ? rounded : undefined;
}

function recognizedConditionalDurationRules(
  task: ExtractedTask,
): ConditionalDurationRule[] {
  return (task.conditionalRules ?? []).flatMap((rule) => {
    const condition = rule.condition.toLocaleLowerCase();
    const effect = rule.effect.toLocaleLowerCase();
    const isNextDayAssessment =
      ASSESSMENT_NOUN.test(condition) &&
      (/\b(?:next|following)\s+day\b/.test(condition) ||
        /\bday\s+before\b/.test(condition));
    const changesDuration =
      /\b(?:use|make|set|last|spend|extend|increase)\b/.test(effect) &&
      /\b(?:minutes?|mins?|hours?|hrs?)\b/.test(effect);
    const relativeIncreaseWithoutTotal =
      /\b(?:extend|increase)\b[^.]{0,40}\bby\b/.test(effect) &&
      !/\b(?:extend|increase)\b[^.]{0,40}\bto\b/.test(effect);
    const minutes = durationMinutesInEffect(effect);
    if (
      !isNextDayAssessment ||
      !changesDuration ||
      relativeIncreaseWithoutTotal ||
      minutes === undefined ||
      minutes <= (task.estimatedMinutes ?? 0)
    ) {
      return [];
    }
    return [{ nextDayAssessment: true as const, minutes }];
  });
}

function looksLikeAssessmentOccurrence(
  title: string,
  task?: ExtractedTask,
): boolean {
  if (!ASSESSMENT_NOUN.test(title) || ASSESSMENT_PREPARATION.test(title)) {
    return false;
  }
  if (!task) return true;
  return (
    task.responsibilityKind === "event" ||
    task.responsibilityKind === "milestone" ||
    task.taskType === "fixed_time" ||
    Boolean(task.occurrenceWindow)
  );
}

function taskOccurrenceDates(
  task: ExtractedTask,
  input: SchedulingInput,
): string[] {
  const dates = new Set<string>();
  const addInstant = (value: string | undefined) => {
    if (!value) return;
    const instant = new Date(value).getTime();
    if (Number.isFinite(instant)) {
      dates.add(localParts(instant, input.preferences.timeZone).date);
    }
  };
  addInstant(task.fixedStartAt);
  addInstant(task.occurrenceWindow?.start);
  addInstant(task.dueAt);
  addInstant(task.dueWindow?.start);
  if (task.dueDate) dates.add(task.dueDate);
  if (task.recurrence?.mode === "fixed_times") {
    timedOccurrenceSlots(task, input).forEach((slot) => dates.add(slot.date));
  }
  return [...dates];
}

function buildConditionalDurationContext(
  tasks: ExtractedTask[],
  input: SchedulingInput,
): ConditionalDurationContext {
  const assessmentDates = new Set<string>();
  for (const task of tasks) {
    if (!looksLikeAssessmentOccurrence(task.title, task)) continue;
    taskOccurrenceDates(task, input).forEach((date) => assessmentDates.add(date));
  }
  for (const session of input.lockedSessions) {
    if (!looksLikeAssessmentOccurrence(session.title)) continue;
    const start = new Date(session.start).getTime();
    if (Number.isFinite(start)) {
      assessmentDates.add(
        localParts(start, input.preferences.timeZone).date,
      );
    }
  }
  return {
    assessmentDates,
    rulesByTaskId: new Map(
      tasks.flatMap((task) => {
        const rules = recognizedConditionalDurationRules(task);
        return rules.length && task.id ? [[task.id, rules]] : [];
      }),
    ),
  };
}

function conditionalDurationForDate(
  task: ExtractedTask,
  date: string,
  context: ConditionalDurationContext | undefined,
  fallbackMinutes = task.estimatedMinutes ?? 0,
): number {
  if (!context || !task.id) return fallbackMinutes;
  const rules = context.rulesByTaskId.get(task.id) ?? [];
  if (rules.length === 0) return fallbackMinutes;
  const nextDate = format(addDays(parseISO(date), 1), "yyyy-MM-dd");
  return rules.some(
    (rule) =>
      rule.nextDayAssessment && context.assessmentDates.has(nextDate),
  )
    ? Math.max(fallbackMinutes, ...rules.map((rule) => rule.minutes))
    : fallbackMinutes;
}

function timedOccurrenceSlots(
  task: ExtractedTask,
  input: SchedulingInput,
  conditionalContext?: ConditionalDurationContext,
): TimedOccurrence[] {
  if (task.recurrence?.mode !== "fixed_times") return [];

  const inputStart = new Date(input.windowStart).getTime();
  const inputEnd = new Date(input.windowEnd).getTime();
  const recurrenceStart = task.recurrence.windowStart
    ? new Date(task.recurrence.windowStart).getTime()
    : inputStart;
  const recurrenceEnd = task.recurrence.windowEnd
    ? new Date(task.recurrence.windowEnd).getTime()
    : inputEnd;
  const effectiveStart = Math.max(inputStart, recurrenceStart);
  const effectiveEnd = Math.min(inputEnd, recurrenceEnd);
  if (effectiveEnd <= effectiveStart) return [];
  const firstDate = localParts(effectiveStart, input.preferences.timeZone).date;
  const lastDate = localParts(effectiveEnd, input.preferences.timeZone).date;
  const slots: TimedOccurrence[] = [];
  const recurrence = task.recurrence;
  const interval = recurrence.interval ?? 1;
  const anchorDate = recurrence.anchorDate ?? firstDate;

  const dateMatchesInterval = (date: string): boolean => {
    if (date < anchorDate) return false;
    if (interval <= 1) return true;
    if (recurrence.frequency === "daily") {
      return (
        differenceInCalendarDays(parseISO(date), parseISO(anchorDate)) %
          interval ===
        0
      );
    }
    if (recurrence.frequency === "weekly") {
      return (
        differenceInCalendarWeeks(parseISO(date), parseISO(anchorDate), {
          weekStartsOn: 1,
        }) %
          interval ===
        0
      );
    }
    return (
      differenceInCalendarMonths(parseISO(date), parseISO(anchorDate)) %
        interval ===
      0
    );
  };

  const monthlyTimes = (date: string, weekday: DayOfWeek): string[] => {
    const dayOfMonth = Number(date.slice(8, 10));
    const ordinal = Math.floor((dayOfMonth - 1) / 7) + 1;
    const nextWeek = format(addDays(parseISO(date), 7), "yyyy-MM-dd");
    const isLast = nextWeek.slice(0, 7) !== date.slice(0, 7);
    return [
      ...new Set(
        recurrence.monthlyRules?.flatMap((rule) => {
          if (rule.type === "days_of_month") {
            return rule.daysOfMonth.includes(dayOfMonth) ? rule.times : [];
          }
          if (rule.type === "last_day_of_month") {
            return isLast ? rule.times : [];
          }
          return rule.dayOfWeek === weekday &&
            (rule.ordinal === ordinal || (rule.ordinal === -1 && isLast))
            ? rule.times
            : [];
        }) ?? [],
      ),
    ].sort();
  };

  for (
    let date = firstDate;
    date <= lastDate;
    date = format(addDays(parseISO(date), 1), "yyyy-MM-dd")
  ) {
    const noon = fromZonedTime(
      `${date}T12:00:00`,
      input.preferences.timeZone,
    ).getTime();
    const weekday = localParts(noon, input.preferences.timeZone)
      .weekday as DayOfWeek;
    const override = recurrence.dateOverrides?.find(
      (item) => item.date === date,
    );
    if (override?.skip) continue;
    if (!override && !dateMatchesInterval(date)) continue;

    let times: string[];
    if (override?.times?.length) {
      times = [...override.times].sort();
    } else if (recurrence.frequency === "monthly") {
      times = monthlyTimes(date, weekday);
    } else {
      if (
        recurrence.daysOfWeek?.length &&
        !recurrence.daysOfWeek.includes(weekday)
      ) {
        continue;
      }
      times = recurrenceTimesForDay(recurrence, weekday);
    }

    for (const time of times) {
      const duration = conditionalDurationForDate(
        task,
        date,
        conditionalContext,
      );
      const start = fromZonedTime(
        `${date}T${time}:00`,
        input.preferences.timeZone,
      ).getTime();
      const end = start + duration * MINUTE;
      if (start < effectiveStart || end > effectiveEnd) continue;
      slots.push({ start, end, date, time });
    }
  }

  const ordered = slots.sort((first, second) => first.start - second.start);
  return recurrence.occurrenceLimit
    ? ordered.slice(0, recurrence.occurrenceLimit)
    : ordered;
}

function candidateReasons(
  task: ExtractedTask,
  localMinute: number,
  deadline: number,
  candidateEnd: number,
  input: SchedulingInput,
  wasSplit: boolean,
): ScheduleReasonCode[] {
  const reasons: ScheduleReasonCode[] = [];
  const focusMatch = input.preferences.preferredFocusWindows.some((window) =>
    isInClockWindow(localMinute, window),
  );
  const routineMatch = input.preferences.preferredRoutineWindows.some(
    (window) => isInClockWindow(localMinute, window),
  );
  if (isOverdueTask(task, input)) {
    reasons.push("OVERDUE_RECOVERY");
  } else if (deadline - candidateEnd <= 24 * 60 * MINUTE) {
    reasons.push("DEADLINE_RISK");
  }
  if (focusMatch && task.energyDemand === "high") {
    reasons.push("PREFERRED_FOCUS_WINDOW");
  }
  if (
    routineMatch &&
    (task.category === "fitness" || task.taskType === "recurring_goal")
  ) {
    reasons.push("PREFERRED_ROUTINE_WINDOW");
  }
  if (task.priority === "high" || task.priority === "urgent") {
    reasons.push("PRIORITY");
  }
  if (task.category === "errand" || task.energyDemand === "low") {
    reasons.push("LOW_ENERGY_FIT");
  }
  if (wasSplit) reasons.push("SPLIT_TO_REDUCE_FATIGUE");
  reasons.push("BUFFER_PRESERVED");
  if (reasons.length === 1) reasons.unshift("EARLY_COMPLETION");
  return [...new Set(reasons)];
}

function sessionFitsAnyDateWindow(
  windows: TemporalWindow[] | undefined,
  start: number,
  end: number,
): boolean {
  return Boolean(
    windows?.some((window) => {
      const windowStart = new Date(window.start).getTime();
      const windowEnd = new Date(window.end).getTime();
      return (
        Number.isFinite(windowStart) &&
        Number.isFinite(windowEnd) &&
        start >= windowStart &&
        end <= windowEnd
      );
    }),
  );
}

function sessionFitsAllowedDateWindow(
  task: ExtractedTask,
  start: number,
  end: number,
): boolean {
  const windows = task.schedulingConstraints?.allowedDateWindows;
  return !windows?.length || sessionFitsAnyDateWindow(windows, start, end);
}

function sessionFitsPreferredDateWindow(
  task: ExtractedTask,
  start: number,
  end: number,
): boolean {
  return sessionFitsAnyDateWindow(
    task.schedulingConstraints?.preferredDateWindows,
    start,
    end,
  );
}

function scheduledTaskBounds(
  taskId: string,
  sessions: PlannedSession[],
  tasksById: Map<string, ExtractedTask>,
  input: SchedulingInput,
): NumericInterval | undefined {
  const taskSessions = sessions.filter((session) => session.taskId === taskId);
  if (taskSessions.length > 0) {
    return {
      start: Math.min(
        ...taskSessions.map((session) => new Date(session.start).getTime()),
      ),
      end: Math.max(
        ...taskSessions.map((session) => new Date(session.end).getTime()),
      ),
    };
  }
  const task = tasksById.get(taskId);
  if (task?.reviewRequired) return undefined;
  if (task?.responsibilityKind === "milestone") {
    if (task.dueAt) {
      const anchor = new Date(task.dueAt).getTime();
      if (Number.isFinite(anchor)) return { start: anchor, end: anchor };
    }
    if (task.dueWindow) {
      const start = new Date(task.dueWindow.start).getTime();
      const end = new Date(task.dueWindow.end).getTime();
      if (Number.isFinite(start) && Number.isFinite(end)) return { start, end };
    }
    if (task.dueDate) {
      const anchor = statedTaskDeadline(task, input);
      if (Number.isFinite(anchor)) return { start: anchor, end: anchor };
    }
  }
  const start = task?.fixedStartAt
    ? new Date(task.fixedStartAt).getTime()
    : task?.occurrenceWindow
      ? new Date(task.occurrenceWindow.start).getTime()
      : Number.NaN;
  const end = task?.fixedEndAt
    ? new Date(task.fixedEndAt).getTime()
    : task?.occurrenceWindow
      ? new Date(task.occurrenceWindow.end).getTime()
      : Number.NaN;
  return Number.isFinite(start) && Number.isFinite(end)
    ? { start, end }
    : undefined;
}

function dependencyPreferenceScore(
  taskId: string,
  start: number,
  end: number,
  dependencyPlan: DependencyPlan,
  sessions: PlannedSession[],
  tasksById: Map<string, ExtractedTask>,
  input: SchedulingInput,
): number {
  let score = 0;
  for (const edge of dependencyPlan.edges) {
    if (edge.strength !== "soft") continue;
    const gap = edge.minimumGapMinutes * MINUTE;
    if (edge.successorId === taskId) {
      const predecessor = scheduledTaskBounds(
        edge.predecessorId,
        sessions,
        tasksById,
        input,
      );
      if (predecessor) {
        score += start >= predecessor.end + gap ? 120 : -80;
      }
    } else if (edge.predecessorId === taskId) {
      const successor = scheduledTaskBounds(
        edge.successorId,
        sessions,
        tasksById,
        input,
      );
      if (successor) {
        score += end + gap <= successor.start ? 120 : -80;
      }
    }
  }
  return score;
}

function respectsExplicitSoftDependencyGaps(
  taskId: string,
  start: number,
  end: number,
  dependencyPlan: DependencyPlan,
  sessions: PlannedSession[],
  tasksById: Map<string, ExtractedTask>,
  input: SchedulingInput,
): boolean {
  return dependencyPlan.edges.every((edge) => {
    if (
      edge.strength !== "soft" ||
      edge.minimumGapMinutes <= 0 ||
      (edge.predecessorId !== taskId && edge.successorId !== taskId)
    ) {
      return true;
    }
    const otherTaskId =
      edge.predecessorId === taskId
        ? edge.successorId
        : edge.predecessorId;
    if (otherTaskId === taskId) return true;
    const other = scheduledTaskBounds(
      otherTaskId,
      sessions,
      tasksById,
      input,
    );
    if (!other) return true;
    const gap = edge.minimumGapMinutes * MINUTE;
    return end + gap <= other.start || start >= other.end + gap;
  });
}

function taskRequiredMinutes(task: ExtractedTask): number {
  const occurrences =
    task.taskType === "recurring_goal"
      ? Math.max(1, task.recurrence?.count ?? 1)
      : 1;
  return (task.estimatedMinutes ?? 0) * occurrences;
}

function completedWithoutScheduledWork(task: ExtractedTask): boolean {
  const requiredMinutes = taskRequiredMinutes(task);
  return (
    task.completed === true ||
    (requiredMinutes > 0 &&
      (task.completedMinutes ?? 0) >= requiredMinutes)
  );
}

function hardDependencyEarliestStart(
  taskId: string,
  dependencyPlan: DependencyPlan,
  sessions: PlannedSession[],
  tasksById: Map<string, ExtractedTask>,
  failedTaskIds: Set<string>,
  input: SchedulingInput,
): {
  blocked: boolean;
  earliestStart?: number;
  latestStart?: number;
  constrained: boolean;
} {
  const incoming = dependencyPlan.edges.filter(
    (edge) => edge.strength === "hard" && edge.successorId === taskId,
  );
  if (incoming.length === 0) return { blocked: false, constrained: false };

  let earliestStart = new Date(input.windowStart).getTime();
  let latestStart: number | undefined;
  for (const edge of incoming) {
    if (failedTaskIds.has(edge.predecessorId)) {
      return { blocked: true, constrained: true };
    }
    const bounds = scheduledTaskBounds(
      edge.predecessorId,
      sessions,
      tasksById,
      input,
    );
    if (bounds) {
      const predecessorEnd = bounds.end;
      earliestStart = Math.max(
        earliestStart,
        predecessorEnd + edge.minimumGapMinutes * MINUTE,
      );
      if (edge.maximumLagMinutes !== undefined) {
        const boundary = predecessorEnd + edge.maximumLagMinutes * MINUTE;
        latestStart =
          latestStart === undefined ? boundary : Math.min(latestStart, boundary);
      }
      continue;
    }
    const predecessor = tasksById.get(edge.predecessorId);
    if (!predecessor || !completedWithoutScheduledWork(predecessor)) {
      return { blocked: true, constrained: true };
    }
    if (edge.maximumLagMinutes !== undefined && !predecessor.completedAt) {
      // A maximum lag needs a real completion instant. Guessing one from the
      // planning-window boundary could silently place the successor too late.
      return { blocked: true, constrained: true };
    }
    const completedAt = predecessor.completedAt
      ? new Date(predecessor.completedAt).getTime()
      : new Date(input.windowStart).getTime();
    if (Number.isFinite(completedAt)) {
      earliestStart = Math.max(
        earliestStart,
        completedAt + edge.minimumGapMinutes * MINUTE,
      );
      if (edge.maximumLagMinutes !== undefined) {
        const boundary = completedAt + edge.maximumLagMinutes * MINUTE;
        latestStart =
          latestStart === undefined ? boundary : Math.min(latestStart, boundary);
      }
    }
  }
  return latestStart !== undefined && earliestStart > latestStart
    ? { blocked: true, constrained: true }
    : { blocked: false, earliestStart, latestStart, constrained: true };
}

function hardDependencyCompletionBounds(
  taskId: string,
  dependencyPlan: DependencyPlan,
  sessions: PlannedSession[],
  tasksById: Map<string, ExtractedTask>,
  input: SchedulingInput,
): { earliestEnd?: number; latestEnd?: number } {
  let earliestEnd: number | undefined;
  let latestEnd: number | undefined;
  for (const edge of dependencyPlan.edges) {
    if (edge.strength !== "hard" || edge.predecessorId !== taskId) continue;
    const successor = scheduledTaskBounds(
      edge.successorId,
      sessions,
      tasksById,
      input,
    );
    if (!successor) continue;
    const latestBoundary = successor.start - edge.minimumGapMinutes * MINUTE;
    latestEnd =
      latestEnd === undefined
        ? latestBoundary
        : Math.min(latestEnd, latestBoundary);
    if (edge.maximumLagMinutes !== undefined) {
      const earliestBoundary =
        successor.start - edge.maximumLagMinutes * MINUTE;
      earliestEnd =
        earliestEnd === undefined
          ? earliestBoundary
          : Math.max(earliestEnd, earliestBoundary);
    }
  }
  return { earliestEnd, latestEnd };
}

function firstRelevantPreferredDateWindowStart(
  task: ExtractedTask,
  deadline: number,
  input: SchedulingInput,
): number | undefined {
  const planningStart = new Date(input.windowStart).getTime();
  const planningEnd = Math.min(
    deadline,
    new Date(input.windowEnd).getTime(),
  );
  const first = [...(task.schedulingConstraints?.preferredDateWindows ?? [])]
    .map((window) => ({
      start: new Date(window.start).getTime(),
      end: new Date(window.end).getTime(),
    }))
    .filter(
      (window) =>
        Number.isFinite(window.start) &&
        Number.isFinite(window.end) &&
        window.end > planningStart &&
        window.start < planningEnd,
    )
    .sort((firstWindow, secondWindow) => firstWindow.start - secondWindow.start)[0];
  return first
    ? Math.min(planningEnd, Math.max(planningStart, first.start))
    : undefined;
}

function taskTargetStart(
  task: ExtractedTask,
  deadline: number,
  input: SchedulingInput,
): number {
  const windowStart = new Date(input.windowStart).getTime();
  const windowEnd = new Date(input.windowEnd).getTime();
  const preferredDateWindowStart = firstRelevantPreferredDateWindowStart(
    task,
    deadline,
    input,
  );
  if (preferredDateWindowStart !== undefined) {
    return preferredDateWindowStart;
  }
  const targetFraction =
    task.schedulingConstraints?.avoidConsecutiveDays ||
    (task.taskType === "recurring_goal" && (task.recurrence?.interval ?? 1) > 1)
      ? 0
      : task.dueAt || task.dueWindow || task.dueDate
        ? task.priority === "urgent"
          ? 0.2
          : task.priority === "high"
            ? 0.3
            : task.priority === "medium"
              ? 0.45
              : 0.6
        : 0.25;
  const targetDeadline = Math.min(deadline, windowEnd);
  return (
    windowStart + Math.max(0, targetDeadline - windowStart) * targetFraction
  );
}

function candidateScore(
  task: ExtractedTask,
  start: number,
  deadline: number,
  input: SchedulingInput,
  local: LocalParts,
  dayLoad: CandidateDayLoad | undefined,
  durationMinutes: number,
  adjacentTaskDay: boolean,
  sessions: PlannedSession[],
  dependencyPlan: DependencyPlan,
  tasksById: Map<string, ExtractedTask>,
): number {
  const mode = PLANNING_MODE_CONFIG[input.preferences.planningMode];
  const focusMatch = input.preferences.preferredFocusWindows.some((window) =>
    isInClockWindow(local.minutes, window),
  );
  const routineMatch = input.preferences.preferredRoutineWindows.some(
    (window) => isInClockWindow(local.minutes, window),
  );
  const sameTaskDayOccurrences = dayLoad?.taskOccurrences ?? 0;
  const sameDayMinutes = dayLoad?.minutes ?? 0;
  const sameDaySessionCount = dayLoad?.sessionCount ?? 0;
  const windowStart = new Date(input.windowStart).getTime();
  const windowEnd = new Date(input.windowEnd).getTime();

  if (isOverdueTask(task, input)) {
    return (
      1_000_000 -
      (start - windowStart) / MINUTE -
      sameDayMinutes * 0.5 -
      sameTaskDayOccurrences * 30
    );
  }

  const targetStart = taskTargetStart(task, deadline, input);
  const distanceFromTargetHours = Math.abs(start - targetStart) / (60 * MINUTE);
  const distributionWeight =
    input.preferences.planningMode === "conservative"
      ? 1
      : input.preferences.planningMode === "balanced"
        ? 0.8
        : 0.55;
  let score =
    PRIORITY_WEIGHT[task.priority] +
    -distanceFromTargetHours * 1.5 -
    (sameDayMinutes * 0.45 + sameDaySessionCount * 20) *
      distributionWeight -
    sameTaskDayOccurrences * 80 +
    mode.earlyCompletionWeight *
      (1 -
        (start - windowStart) /
          Math.max(
            1,
            windowEnd - windowStart,
          ));

  if (task.energyDemand === "high") score += focusMatch ? 38 : -22;
  if (task.category === "fitness" || task.taskType === "recurring_goal") {
    score += routineMatch ? 34 : 0;
  }
  if (task.category === "errand" && focusMatch) score -= 30;
  if (task.energyDemand === "low" && !focusMatch) score += 12;
  const preferredTaskWindow = task.schedulingConstraints?.preferredTimeWindows?.some(
    (window) => sessionFitsClockWindow(local.minutes, durationMinutes, window),
  );
  if (preferredTaskWindow) score += 52;
  if (
    sessionFitsPreferredDateWindow(
      task,
      start,
      start + durationMinutes * MINUTE,
    )
  ) {
    score += 120;
  }
  if (task.schedulingConstraints?.avoidConsecutiveDays && adjacentTaskDay) {
    score -= 700;
  }
  if (task.taskType === "recurring_goal") {
    score -= sameTaskDayOccurrences * 70;
  }
  const explicitTaskWindow = Boolean(
    task.schedulingConstraints?.allowedTimeWindows?.length ||
      task.schedulingConstraints?.preferredTimeWindows?.length,
  );
  if (!explicitTaskWindow) {
    score -= wakingEdgePenalty(
      local.minutes,
      durationMinutes,
      input.preferences.wakingTime,
      input.preferences.sleepingTime,
    );
  }
  if (task.id && dependencyPlan.edges.length > 0) {
    score += dependencyPreferenceScore(
      task.id,
      start,
      start + durationMinutes * MINUTE,
      dependencyPlan,
      sessions,
      tasksById,
      input,
    );
  }
  score += mode.densityWeight;
  return score;
}

function sparseCandidateStarts(
  task: ExtractedTask,
  minutes: number,
  deadline: number,
  input: SchedulingInput,
  interval: NumericInterval,
  busy: NumericInterval[],
  breakMinutes: number,
): number[] {
  const duration = (minutes + breakMinutes) * MINUTE;
  const ideal = taskTargetStart(task, deadline, input);
  const gaps: NumericInterval[] = [];
  let cursor = interval.start;
  let firstBusy = 0;
  let busyEnd = busy.length;
  while (firstBusy < busyEnd) {
    const middle = (firstBusy + busyEnd) >>> 1;
    if (busy[middle].end <= cursor) firstBusy = middle + 1;
    else busyEnd = middle;
  }
  for (let index = firstBusy; index < busy.length; index += 1) {
    const blocked = busy[index];
    if (blocked.end <= cursor) continue;
    if (blocked.start >= interval.end) break;
    if (blocked.start > cursor) {
      gaps.push({ start: cursor, end: Math.min(blocked.start, interval.end) });
    }
    cursor = Math.max(cursor, blocked.end);
    if (cursor >= interval.end) break;
  }
  if (cursor < interval.end) gaps.push({ start: cursor, end: interval.end });

  const taskWindows = [
    ...input.preferences.preferredFocusWindows,
    ...input.preferences.preferredRoutineWindows,
    ...(task.schedulingConstraints?.allowedTimeWindows ?? []),
    ...(task.schedulingConstraints?.preferredTimeWindows ?? []),
  ];
  const starts = new Set<number>();
  const add = (value: number, minimum: number, maximum: number) => {
    const clamped = Math.min(maximum, Math.max(minimum, value));
    const rounded = floorToIncrement(clamped);
    for (const candidate of [rounded, rounded + SCHEDULER_INCREMENT_MINUTES * MINUTE]) {
      if (candidate >= minimum && candidate <= maximum) starts.add(candidate);
    }
  };

  for (const gap of gaps) {
    const minimum = ceilToIncrement(gap.start);
    const maximum = floorToIncrement(gap.end - duration);
    if (maximum < minimum) continue;
    add(minimum, minimum, maximum);
    add(maximum, minimum, maximum);
    add(ideal, minimum, maximum);
    for (const window of [
      ...(task.schedulingConstraints?.allowedDateWindows ?? []),
      ...(task.schedulingConstraints?.preferredDateWindows ?? []),
    ]) {
      const preferredStart = new Date(window.start).getTime();
      const preferredEnd = new Date(window.end).getTime();
      if (!Number.isFinite(preferredStart) || !Number.isFinite(preferredEnd)) {
        continue;
      }
      add(preferredStart, minimum, maximum);
      add(preferredEnd - minutes * MINUTE, minimum, maximum);
    }
    const date = localParts(minimum, input.preferences.timeZone).date;
    for (const window of taskWindows) {
      const windowStartAt = zonedClockInstant(
        date,
        window.start,
        input.preferences.timeZone,
      );
      let windowEndDate = date;
      if (clockMinutes(window.end) <= clockMinutes(window.start)) {
        windowEndDate = format(addDays(parseISO(date), 1), "yyyy-MM-dd");
      }
      const windowEndAt = zonedClockInstant(
        windowEndDate,
        window.end,
        input.preferences.timeZone,
      );
      add(windowStartAt, minimum, maximum);
      add(windowEndAt - minutes * MINUTE, minimum, maximum);
    }
  }
  return [...starts].sort((first, second) => first - second);
}

function availabilityRangeForCapacity(
  availability: NumericInterval[],
  target: number,
  requiredMinutes: number,
): { start: number; end: number } | undefined {
  if (availability.length === 0) return undefined;
  const byDistance = availability
    .map((interval, index) => ({
      index,
      minutes: intervalMinutes(interval),
      distance:
        target < interval.start
          ? interval.start - target
          : target > interval.end
            ? target - interval.end
            : 0,
    }))
    .sort(
      (first, second) =>
        first.distance - second.distance || first.index - second.index,
    );
  let capacity = 0;
  let start = availability.length - 1;
  let end = 0;
  for (const candidate of byDistance) {
    capacity += candidate.minutes;
    start = Math.min(start, candidate.index);
    end = Math.max(end, candidate.index);
    if (capacity >= requiredMinutes) break;
  }
  return { start, end };
}

function findCandidate(
  task: ExtractedTask,
  minutes: number,
  deadline: number,
  input: SchedulingInput,
  availability: NumericInterval[],
  busy: NumericInterval[],
  sessions: PlannedSession[],
  dependencyPlan: DependencyPlan,
  tasksById: Map<string, ExtractedTask>,
  demandingByDay: Map<string, number>,
  wasSplit: boolean,
  earliestStart?: number,
  latestTaskStart?: number,
  minimumTaskEnd?: number,
  conditionalContext?: ConditionalDurationContext,
  totalRequestedMinutes = 0,
  searchAllGenericAvailability = false,
): Candidate | undefined {
  const mode = PLANNING_MODE_CONFIG[input.preferences.planningMode];
  const taskSessions = sessions.filter((session) => session.taskId === task.id);
  const minimumDistinctDays = task.schedulingConstraints?.minimumDistinctDays ?? 0;
  const existingTaskStart = taskSessions.length
    ? Math.min(
        ...taskSessions.map((session) => new Date(session.start).getTime()),
      )
    : undefined;
  const existingTaskEnd = taskSessions.length
    ? Math.max(...taskSessions.map((session) => new Date(session.end).getTime()))
    : undefined;
  const dayLoads = new Map<string, CandidateDayLoad>();
  const taskSessionDates = new Set<string>();
  for (const session of sessions) {
    const date = localParts(
      new Date(session.start).getTime(),
      input.preferences.timeZone,
    ).date;
    const load = dayLoads.get(date) ?? {
      sessionCount: 0,
      minutes: 0,
      taskOccurrences: 0,
    };
    load.sessionCount += 1;
    load.minutes += session.minutes;
    if (session.taskId === task.id) load.taskOccurrences += 1;
    if (session.taskId === task.id) taskSessionDates.add(date);
    dayLoads.set(date, load);
  }
  let bestCandidate: Candidate | undefined;
  const increment = SCHEDULER_INCREMENT_MINUTES * MINUTE;
  const breakMinutes =
    task.energyDemand === "high" ? input.preferences.preferredBreakMinutes : 0;
  let firstSequenceCandidateDate: string | undefined;
  const sparseSearch = input.tasks.length >= 100;
  const canLimitGenericSearch =
    sparseSearch &&
    !searchAllGenericAvailability &&
    !task.dueAt &&
    !task.dueWindow &&
    !task.dueDate &&
    !task.recurrence &&
    !taskSequence(task) &&
    !task.schedulingConstraints?.allowedTimeWindows?.length &&
    !task.schedulingConstraints?.allowedDateWindows?.length &&
    !task.schedulingConstraints?.preferredDateWindows?.length &&
    !task.schedulingConstraints?.avoidConsecutiveDays;
  const genericTarget = canLimitGenericSearch
    ? taskTargetStart(task, deadline, input)
    : undefined;
  const genericAvailabilityRange =
    genericTarget === undefined
      ? undefined
      : availabilityRangeForCapacity(
          availability,
          genericTarget,
          totalRequestedMinutes / Math.max(0.05, 1 - mode.bufferRatio),
        );

  for (let intervalIndex = 0; intervalIndex < availability.length; intervalIndex += 1) {
    if (
      genericAvailabilityRange &&
      (intervalIndex < genericAvailabilityRange.start ||
        intervalIndex > genericAvailabilityRange.end)
    ) {
      continue;
    }
    const interval = availability[intervalIndex];
    const intervalStart = Math.max(
      interval.start,
      earliestStart ?? Number.NEGATIVE_INFINITY,
    );
    if (intervalStart >= interval.end) continue;
    const intervalDate = localParts(
      intervalStart,
      input.preferences.timeZone,
    ).date;
    if (
      earliestStart !== undefined &&
      firstSequenceCandidateDate &&
      intervalDate > firstSequenceCandidateDate
    ) {
      break;
    }
    const lastStart = Math.min(interval.end, deadline) - minutes * MINUTE;
    const candidateStarts: Iterable<number> =
      sparseSearch
        ? sparseCandidateStarts(
            task,
            conditionalDurationForDate(
              task,
              intervalDate,
              conditionalContext,
              minutes,
            ),
            deadline,
            input,
            { start: intervalStart, end: Math.min(interval.end, deadline) },
            busy,
            breakMinutes,
          )
        : denseCandidateStarts(ceilToIncrement(intervalStart), lastStart);
    // Exact dependency boundaries can fall between the ordinary 15-minute
    // search increments (a drive ending at 4:05, for example). Try those
    // instants as well; every normal availability/conflict check still runs.
    const boundaryStarts = [
      earliestStart,
      latestTaskStart,
      minimumTaskEnd === undefined ? undefined : minimumTaskEnd - minutes * MINUTE,
    ].filter((value): value is number => value !== undefined && Number.isFinite(value) && value >= intervalStart && value <= lastStart);
    function* withBoundaries(): Generator<number> {
      yield* candidateStarts;
      yield* boundaryStarts;
    }
    for (const start of boundaryStarts.length ? withBoundaries() : candidateStarts) {
      const local = localParts(start, input.preferences.timeZone);
      const candidateMinutes = Math.max(
        minutes,
        conditionalDurationForDate(
          task,
          local.date,
          conditionalContext,
          minutes,
        ),
      );
      const end = start + candidateMinutes * MINUTE;
      const slot = { start, end };
      const breakSlot = {
        start: end,
        end: end + breakMinutes * MINUTE,
      };
      const recurrenceStart = task.recurrence?.windowStart
        ? new Date(task.recurrence.windowStart).getTime()
        : Number.NEGATIVE_INFINITY;
      if (
        (earliestStart !== undefined && start < earliestStart) ||
        (latestTaskStart !== undefined &&
          Math.min(existingTaskStart ?? start, start) > latestTaskStart) ||
        (minimumTaskEnd !== undefined &&
          Math.max(existingTaskEnd ?? end, end) < minimumTaskEnd) ||
        end > interval.end ||
        end > deadline ||
        start < recurrenceStart ||
        !quotaRecurrenceAllowsDate(
          task,
          local.date,
          local.weekday as DayOfWeek,
          taskSessions,
          input.preferences.timeZone,
        )
      ) {
        continue;
      }
      // When the task explicitly requires multiple days, reserve one session
      // on a new local date until the minimum distinct-day count is reached.
      // Once that count is met, additional sessions may share a date.
      if (
        minimumDistinctDays > taskSessionDates.size &&
        taskSessionDates.has(local.date)
      ) {
        continue;
      }
      if (
        task.schedulingConstraints?.allowedTimeWindows?.length &&
        !task.schedulingConstraints.allowedTimeWindows.some((window) =>
          sessionFitsClockWindow(local.minutes, candidateMinutes, window),
        )
      ) {
        continue;
      }
      if (!sessionFitsAllowedDateWindow(task, start, end)) continue;
      if (
        task.id &&
        dependencyPlan.edges.length > 0 &&
        !respectsExplicitSoftDependencyGaps(
          task.id,
          start,
          end,
          dependencyPlan,
          sessions,
          tasksById,
          input,
        )
      ) {
        continue;
      }
      if (
        !input.preferences.weekendsAllowed &&
        (local.weekday === "saturday" || local.weekday === "sunday")
      ) {
        continue;
      }
      if (
        !isWithinWakingHours(
          start,
          input.preferences.wakingTime,
          input.preferences.sleepingTime,
          input.preferences.timeZone,
        ) ||
        !isWithinWakingHours(
          Math.max(start, end - MINUTE),
          input.preferences.wakingTime,
          input.preferences.sleepingTime,
          input.preferences.timeZone,
        )
      ) {
        continue;
      }
      if (!isFree(slot, busy)) continue;
      if (
        breakMinutes > 0 &&
        (breakSlot.end > interval.end || !isFree(breakSlot, busy))
      ) {
        continue;
      }
      if (
        task.energyDemand === "high" &&
        (demandingByDay.get(local.date) ?? 0) >= mode.demandingBlockLimit
      ) {
        continue;
      }
      const reasons = candidateReasons(
        task,
        local.minutes,
        deadline,
        end,
        input,
        wasSplit,
      );
      if (deadline - end <= increment) reasons.unshift("FINAL_VALID_OPENING");
      if (task.taskType === "recurring_goal" && taskSessions.length > 0) {
        reasons.push("RECURRING_SPACING");
      }
      const adjacentTaskDay = [...taskSessionDates].some(
        (date) =>
          Math.abs(
            differenceInCalendarDays(parseISO(local.date), parseISO(date)),
          ) === 1,
      );
      if (
        task.schedulingConstraints?.allowedTimeWindows?.some((window) =>
          sessionFitsClockWindow(local.minutes, candidateMinutes, window),
        ) ||
        task.schedulingConstraints?.preferredTimeWindows?.some((window) =>
          sessionFitsClockWindow(local.minutes, candidateMinutes, window),
        ) ||
        task.schedulingConstraints?.allowedDateWindows?.length ||
        sessionFitsPreferredDateWindow(task, start, end)
      ) {
        reasons.push("TASK_TIME_WINDOW");
      }
      if (
        task.schedulingConstraints?.avoidConsecutiveDays &&
        taskSessions.length > 0 &&
        !adjacentTaskDay
      ) {
        reasons.push("REST_DAY_SPACING");
      }
      const candidate: Candidate = {
        start,
        end,
        minutes: candidateMinutes,
        localDate: local.date,
        adjacentTaskDay,
        score: candidateScore(
          task,
          start,
          deadline,
          input,
          local,
          dayLoads.get(local.date),
          candidateMinutes,
          adjacentTaskDay,
          sessions,
          dependencyPlan,
          tasksById,
        ),
        reasons: [...new Set(reasons)],
      };
      const candidateIsBetter =
        !bestCandidate ||
        ((task.schedulingConstraints?.avoidConsecutiveDays
          ? Number(candidate.adjacentTaskDay) -
            Number(bestCandidate.adjacentTaskDay)
          : 0) ||
          (earliestStart !== undefined
            ? candidate.localDate.localeCompare(bestCandidate.localDate) ||
              bestCandidate.score - candidate.score ||
              candidate.start - bestCandidate.start
            : bestCandidate.score - candidate.score ||
              candidate.start - bestCandidate.start)) < 0;
      if (candidateIsBetter) bestCandidate = candidate;
      if (earliestStart !== undefined) firstSequenceCandidateDate ??= local.date;
    }
  }

  if (!bestCandidate && genericAvailabilityRange) {
    return findCandidate(
      task,
      minutes,
      deadline,
      input,
      availability,
      busy,
      sessions,
      dependencyPlan,
      tasksById,
      demandingByDay,
      wasSplit,
      earliestStart,
      latestTaskStart,
      minimumTaskEnd,
      conditionalContext,
      totalRequestedMinutes,
      true,
    );
  }
  return bestCandidate;
}

function chunkDurations(
  total: number,
  preferred: number,
  maximum: number,
  minimum: number,
): number[] {
  if (total <= maximum) return [total];
  const chunks: number[] = [];
  let remaining = total;
  while (remaining > maximum) {
    const chunk = Math.min(preferred, maximum);
    chunks.push(chunk);
    remaining -= chunk;
  }
  if (remaining > 0 && remaining < minimum && chunks.length > 0) {
    const needed = minimum - remaining;
    const donorIndex = chunks.findIndex(
      (chunk) => chunk - needed >= minimum,
    );
    if (donorIndex >= 0) {
      chunks[donorIndex] -= needed;
      remaining += needed;
    } else {
      chunks[chunks.length - 1] += remaining;
      return chunks;
    }
  }
  if (remaining > 0) chunks.push(remaining);
  return chunks;
}

function exactSessionDurations(
  total: number,
  count: number,
  minimum: number,
  maximum: number,
): number[] | undefined {
  if (count < 2 || total < count * minimum || total > count * maximum) {
    return undefined;
  }
  const base = Math.floor(total / count / SCHEDULER_INCREMENT_MINUTES) *
    SCHEDULER_INCREMENT_MINUTES;
  const durations = Array.from({ length: count }, () => base);
  let remaining = total - base * count;
  for (let index = count - 1; remaining > 0; index = (index - 1 + count) % count) {
    const addition = Math.min(SCHEDULER_INCREMENT_MINUTES, remaining);
    durations[index] += addition;
    remaining -= addition;
  }
  return durations.every(
    (duration) => duration >= minimum && duration <= maximum,
  )
    ? durations
    : undefined;
}

function unschedulable(
  task: ExtractedTask,
  minutes: number,
  reasonCode: UnschedulableTask["reasonCode"],
): UnschedulableTask {
  const copy: Record<
    UnschedulableTask["reasonCode"],
    { explanation: string; actions: string[] }
  > = {
    INSUFFICIENT_CAPACITY: {
      explanation: `${minutes} minutes do not fit inside the remaining protected capacity.`,
      actions: [
        "Reduce the effort estimate",
        "Open an additional availability window",
        "Use a denser planning mode",
      ],
    },
    NO_VALID_TIME_BEFORE_DEADLINE: {
      explanation: `No valid opening remains before the stated deadline; ${minutes} minutes are still needed.`,
      actions: [
        "Move or clarify the deadline",
        "Open time before the deadline",
        "Split the task into smaller sessions",
      ],
    },
    MISSING_REQUIRED_INFORMATION: {
      explanation:
        "A critical field is uncertain and must be reviewed before scheduling.",
      actions: [
        "Review highlighted fields",
        "Confirm the fixed time or effort estimate",
      ],
    },
    FIXED_TIME_CONFLICT: {
      explanation:
        "The explicit fixed time overlaps another event or blocked period.",
      actions: [
        "Resolve the calendar conflict",
        "Correct the extracted fixed time",
      ],
    },
    SEQUENCE_BLOCKED: {
      explanation:
        "This plan step is waiting because an earlier Week/Day step could not be scheduled.",
      actions: [
        "Schedule or complete the earlier plan step",
        "Open more time for the plan",
        "Reduce the earlier step's effort estimate",
      ],
    },
    MINIMUM_SESSION_TOO_LARGE: {
      explanation: `${minutes} minutes remain, but no opening can satisfy the minimum session length.`,
      actions: [
        "Lower the minimum session length",
        "Open a longer availability window",
      ],
    },
  };
  return {
    taskId: task.id ?? task.title,
    title: task.title,
    unscheduledMinutes: minutes,
    reasonCode,
    explanation: copy[reasonCode].explanation,
    suggestedActions: copy[reasonCode].actions,
  };
}

function calculateFreeMinutes(
  availability: NumericInterval[],
  busy: NumericInterval[],
): number {
  return availability.reduce((total, interval) => {
    const occupied = occupiedMinutesWithin(interval, busy);
    return total + Math.max(0, intervalMinutes(interval) - occupied);
  }, 0);
}

export function generateSchedule(input: SchedulingInput): ScheduleProposal {
  input = { ...input, tasks: input.tasks.map(materializeCalculatedTimeBlock) };
  const arrivalBuffers = arrivalBufferReservations(input.tasks);
  if (arrivalBuffers.length) input = { ...input, blockedTimes: [...input.blockedTimes, ...arrivalBuffers] };
  const availability = mergeIntervals(input.availability.map(toNumeric));
  const baseBusy = mergeIntervals(
    [
      ...input.unavailableEvents,
      ...input.blockedTimes,
      ...input.lockedSessions.map((session) => ({
        start: session.start,
        end: session.end,
      })),
      ...input.tasks.flatMap((task) =>
        task.taskType === "fixed_time" && task.fixedStartAt && task.fixedEndAt
          ? [{ start: task.fixedStartAt, end: task.fixedEndAt }]
          : [],
      ),
    ].map(toNumeric),
  );
  const busy = [...baseBusy];
  const sessions: PlannedSession[] = input.lockedSessions.map((session) => ({
    id: session.id,
    taskId: session.taskId,
    title: session.title,
    start: session.start,
    end: session.end,
    minutes: Math.round(
      (new Date(session.end).getTime() - new Date(session.start).getTime()) /
        MINUTE,
    ),
    status: session.status === "completed" ? "completed" : "approved",
    locked: true,
    reasonCodes: ["STABILITY_PRESERVED"],
    explanation: explainReasons(["STABILITY_PRESERVED"]),
  }));
  const breaks: ScheduledBreak[] = [];
  const unschedulableTasks: UnschedulableTask[] = [];
  const demandingByDay = new Map<string, number>();
  const availableMinutes = calculateFreeMinutes(availability, baseBusy);
  const mode = PLANNING_MODE_CONFIG[input.preferences.planningMode];
  const capacityBudget =
    Math.floor(
      (availableMinutes * (1 - mode.bufferRatio)) /
        SCHEDULER_INCREMENT_MINUTES,
    ) * SCHEDULER_INCREMENT_MINUTES;
  let newlyPlannedMinutes = 0;
  let conditionalQuotaExtraMinutes = 0;

  const normalizedInputTasks = input.tasks.map((task, index) => ({
    ...task,
    id: task.id ?? `task-${index + 1}`,
  }));
  const tasksById = new Map(
    normalizedInputTasks.map((task) => [task.id, task]),
  );
  // Existing calendar blocks and flexible locked work remain hard conflicts.
  // Fixed events are allowed to overlap one another and are surfaced as a
  // warning, so keep their locked intervals out of this conflict set.
  const nonFixedBusy = mergeIntervals(
    [
      ...input.unavailableEvents,
      ...input.blockedTimes,
      ...input.lockedSessions
        .filter((session) => !isFixedTask(tasksById.get(session.taskId)))
        .map((session) => ({ start: session.start, end: session.end })),
    ].map(toNumeric),
  );
  const explicitFixedReservations = normalizedInputTasks.flatMap((task) =>
    task.taskType === "fixed_time" && task.fixedStartAt && task.fixedEndAt
      ? [{
          start: new Date(task.fixedStartAt).getTime(),
          end: new Date(task.fixedEndAt).getTime(),
        }]
      : [],
  );
  const totalRequestedMinutes = normalizedInputTasks.reduce(
    (total, task) =>
      task.responsibilityKind === "milestone"
        ? total
        : total +
          (task.estimatedMinutes ?? 0) *
            Math.max(1, task.recurrence?.count ?? 1),
    0,
  );
  const discoveredConditionalContext = buildConditionalDurationContext(
    normalizedInputTasks,
    input,
  );
  const conditionalContext = discoveredConditionalContext.rulesByTaskId.size
    ? discoveredConditionalContext
    : undefined;
  const dependencyPlan = buildDependencyPlan(
    normalizedInputTasks,
    input.lockedSessions,
  );
  const normalizedTasks = tasksInSchedulingOrder(
    normalizedInputTasks,
    input,
    availability,
    busy,
    dependencyPlan,
  );
  const sequenceProgress = new Map<string, SequenceProgress>();
  const failedTaskIds = new Set<string>();

  for (const task of normalizedTasks) {
    const taskId = task.id ?? task.title;
    const estimate = task.estimatedMinutes ?? 0;
    const sequence = taskSequence(task);
    const progress = sequence
      ? (sequenceProgress.get(sequence.groupId) ?? {
          blocked: false,
        })
      : undefined;
    if (sequence && progress) {
      sequenceProgress.set(sequence.groupId, progress);
      if (progress.blocked) {
        unschedulableTasks.push(
          unschedulable(task, estimate, "SEQUENCE_BLOCKED"),
        );
        failedTaskIds.add(taskId);
        continue;
      }
    }
    if (
      dependencyPlan.unresolvedHardTaskIds.has(taskId) ||
      dependencyPlan.cycleBlockedTaskIds.has(taskId)
    ) {
      unschedulableTasks.push(
        unschedulable(task, estimate, "MISSING_REQUIRED_INFORMATION"),
      );
      failedTaskIds.add(taskId);
      if (progress) progress.blocked = true;
      continue;
    }
    if (task.reviewRequired && !isCalculatedFixedTime(task)) {
      unschedulableTasks.push(unschedulable(task, estimate, "MISSING_REQUIRED_INFORMATION"));
      failedTaskIds.add(taskId);
      if (progress) progress.blocked = true;
      continue;
    }
    if (task.responsibilityKind === "milestone") {
      const anchor = scheduledTaskBounds(taskId, sessions, tasksById, input);
      if (!anchor) {
        unschedulableTasks.push(
          unschedulable(task, 0, "MISSING_REQUIRED_INFORMATION"),
        );
        failedTaskIds.add(taskId);
        if (progress) progress.blocked = true;
      } else if (progress) {
        progress.lastDate = localParts(
          anchor.end,
          input.preferences.timeZone,
        ).date;
      }
      continue;
    }
    const earliestSequenceStart =
      sequence && progress
        ? sequenceEarliestStart(sequence, progress, input)
        : undefined;
    const dependencyStart = hardDependencyEarliestStart(
      taskId,
      dependencyPlan,
      sessions,
      tasksById,
      failedTaskIds,
      input,
    );
    if (dependencyStart.blocked) {
      unschedulableTasks.push(
        unschedulable(task, estimate, "SEQUENCE_BLOCKED"),
      );
      failedTaskIds.add(taskId);
      if (progress) progress.blocked = true;
      continue;
    }
    const earliestTaskStart = Math.max(
      earliestSequenceStart ?? Number.NEGATIVE_INFINITY,
      dependencyStart.earliestStart ?? Number.NEGATIVE_INFINITY,
    );
    const constrainedEarliestStart = Number.isFinite(earliestTaskStart)
      ? earliestTaskStart
      : undefined;
    const dependencyCompletionBounds = hardDependencyCompletionBounds(
      taskId,
      dependencyPlan,
      sessions,
      tasksById,
      input,
    );
    const earliestDependencyEnd = dependencyCompletionBounds.earliestEnd;
    const latestDependencyEnd = dependencyCompletionBounds.latestEnd;
    if (
      earliestDependencyEnd !== undefined &&
      latestDependencyEnd !== undefined &&
      earliestDependencyEnd > latestDependencyEnd
    ) {
      unschedulableTasks.push(
        unschedulable(task, estimate, "MISSING_REQUIRED_INFORMATION"),
      );
      failedTaskIds.add(taskId);
      if (progress) progress.blocked = true;
      continue;
    }
    if (
      (task.reviewRequired && !isCalculatedFixedTime(task)) ||
      (task.taskType === "fixed_time" &&
        (!task.fixedStartAt || !task.fixedEndAt)) ||
      estimate <= 0
    ) {
      unschedulableTasks.push(
        unschedulable(task, estimate, "MISSING_REQUIRED_INFORMATION"),
      );
      failedTaskIds.add(taskId);
      if (progress) progress.blocked = true;
      continue;
    }

    if (task.taskType === "fixed_time") {
      const start = new Date(task.fixedStartAt ?? "").getTime();
      const end = new Date(task.fixedEndAt ?? "").getTime();
      const slot = { start, end };
      const minutes = intervalMinutes(slot);
      if (hasMatchingLockedSession(task.id ?? task.title, start, end, input)) {
        if (progress) updateSequenceProgress(progress, task, sessions, input);
        continue;
      }
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        (constrainedEarliestStart !== undefined &&
          start < constrainedEarliestStart) ||
        (dependencyStart.latestStart !== undefined &&
          start > dependencyStart.latestStart) ||
        (earliestDependencyEnd !== undefined && end < earliestDependencyEnd) ||
        (latestDependencyEnd !== undefined && end > latestDependencyEnd) ||
        !explicitTimeIsAllowed(slot, input, availability) ||
        !sessionFitsAllowedDateWindow(task, start, end) ||
        !respectsExplicitSoftDependencyGaps(
          taskId,
          start,
          end,
          dependencyPlan,
          sessions,
          tasksById,
          input,
        ) ||
        (!isFree(slot, nonFixedBusy) ||
          (!isFree(slot, busy) &&
            !explicitFixedReservations.some((reservation) => overlaps(slot, reservation)) &&
            !sessions.some((session) =>
              isFixedTask(tasksById.get(session.taskId)) &&
              overlaps(slot, {
                start: new Date(session.start).getTime(),
                end: new Date(session.end).getTime(),
              }),
            )))
      ) {
        unschedulableTasks.push(
          unschedulable(task, minutes || estimate, "FIXED_TIME_CONFLICT"),
        );
        failedTaskIds.add(taskId);
        if (progress) progress.blocked = true;
        continue;
      }
      const reasons: ScheduleReasonCode[] =
        sequence || dependencyStart.constrained
        ? ["FIXED_TIME", "SEQUENCE_ORDER"]
        : ["FIXED_TIME"];
      const session: PlannedSession = {
        id: `session-${task.id}-1`,
        taskId: task.id ?? task.title,
        title: task.title,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        minutes,
        status: "proposed",
        locked: true,
        reasonCodes: reasons,
        explanation: `${explainReasons(reasons)}${isCalculatedFixedTime(task) && task.reviewRequired ? " AI-interpreted, calculator-derived timing. Check this fixed proposal before approving it." : ""}`,
      };
      sessions.push(session);
      insertBusyInterval(busy, slot);
      newlyPlannedMinutes += minutes;
      if (progress) updateSequenceProgress(progress, task, sessions, input);
      continue;
    }

    if (task.recurrence?.mode === "fixed_times") {
      const occurrences = timedOccurrenceSlots(task, input, conditionalContext);
      let conflictedMinutes = 0;
      for (const [index, slot] of occurrences.entries()) {
        const minutes = intervalMinutes(slot);
        if (
          hasMatchingLockedSession(
            task.id ?? task.title,
            slot.start,
            slot.end,
            input,
          )
        ) {
          continue;
        }
        if (
          (constrainedEarliestStart !== undefined &&
            slot.start < constrainedEarliestStart) ||
          (index === 0 &&
            dependencyStart.latestStart !== undefined &&
            slot.start > dependencyStart.latestStart) ||
          (index === occurrences.length - 1 &&
            earliestDependencyEnd !== undefined &&
            slot.end < earliestDependencyEnd) ||
          (latestDependencyEnd !== undefined && slot.end > latestDependencyEnd) ||
          !explicitTimeIsAllowed(slot, input, availability) ||
          !sessionFitsAllowedDateWindow(task, slot.start, slot.end) ||
          !respectsExplicitSoftDependencyGaps(
            taskId,
            slot.start,
            slot.end,
            dependencyPlan,
            sessions,
            tasksById,
            input,
          ) ||
          (!isFree(slot, nonFixedBusy) ||
            (!isFree(slot, busy) &&
              !explicitFixedReservations.some((reservation) => overlaps(slot, reservation)) &&
              !sessions.some((session) =>
                isFixedTask(tasksById.get(session.taskId)) &&
                overlaps(slot, {
                  start: new Date(session.start).getTime(),
                  end: new Date(session.end).getTime(),
                }),
              )))
        ) {
          conflictedMinutes += minutes;
          continue;
        }
        const reasons: ScheduleReasonCode[] =
          sequence || dependencyStart.constrained
          ? ["FIXED_TIME", "SEQUENCE_ORDER"]
          : ["FIXED_TIME"];
        const session: PlannedSession = {
          id: `session-${task.id}-${slot.date}-${slot.time.replace(":", "")}-${index + 1}`,
          taskId: task.id ?? task.title,
          title: task.title,
          start: new Date(slot.start).toISOString(),
          end: new Date(slot.end).toISOString(),
          minutes,
          status: "proposed",
          locked: true,
          reasonCodes: reasons,
          explanation: explainReasons(reasons),
        };
        sessions.push(session);
        insertBusyInterval(busy, { start: slot.start, end: slot.end });
        newlyPlannedMinutes += minutes;
      }
      if (conflictedMinutes > 0) {
        unschedulableTasks.push(
          unschedulable(task, conflictedMinutes, "FIXED_TIME_CONFLICT"),
        );
        failedTaskIds.add(taskId);
        if (progress) progress.blocked = true;
      } else if (progress) {
        updateSequenceProgress(progress, task, sessions, input);
      }
      continue;
    }

    const occurrences =
      task.taskType === "recurring_goal"
        ? Math.max(1, task.recurrence?.count ?? 1)
        : 1;
    const totalMinutes = estimate * occurrences;
    const remainingMinutes = Math.max(
      0,
      totalMinutes -
        (task.completedMinutes ?? 0) -
        committedMinutesForTask(task.id ?? task.title, input),
    );
    if (remainingMinutes === 0) {
      if (progress) updateSequenceProgress(progress, task, sessions, input);
      continue;
    }
    const minimum =
      task.minimumSessionMinutes ?? SCHEDULER_INCREMENT_MINUTES;
    const maximum = Math.min(
      input.preferences.maximumBlockMinutes,
      task.schedulingConstraints?.maximumSessionMinutes ??
        input.preferences.maximumBlockMinutes,
    );
    if (minimum > maximum) {
      unschedulableTasks.push(
        unschedulable(task, remainingMinutes, "MINIMUM_SESSION_TOO_LARGE"),
      );
      failedTaskIds.add(taskId);
      if (progress) progress.blocked = true;
      continue;
    }
    const durations =
      task.taskType === "recurring_goal"
        ? Array.from(
            { length: Math.ceil(remainingMinutes / estimate) },
            (_, index) =>
              Math.min(estimate, remainingMinutes - index * estimate),
          )
        : task.splittable
          ? (exactSessionDurations(
              remainingMinutes,
              task.schedulingConstraints?.sessionCount ?? 0,
              minimum,
              maximum,
            ) ?? chunkDurations(
              remainingMinutes,
              Math.min(input.preferences.preferredBlockMinutes, maximum),
              maximum,
              minimum,
            ))
          : [remainingMinutes];
    if (
      !task.splittable &&
      task.taskType !== "recurring_goal" &&
      remainingMinutes > maximum
    ) {
      unschedulableTasks.push(
        unschedulable(task, remainingMinutes, "MINIMUM_SESSION_TOO_LARGE"),
      );
      failedTaskIds.add(taskId);
      if (progress) progress.blocked = true;
      continue;
    }

    let unscheduledMinutes = 0;
    for (let index = 0; index < durations.length; index += 1) {
      const minutes = durations[index];
      if (newlyPlannedMinutes + minutes > capacityBudget) {
        unscheduledMinutes += durations.slice(index).reduce(
          (sum, duration) => sum + duration,
          0,
        );
        break;
      }
      const deadline = Math.min(
        taskDeadline(task, input),
        latestDependencyEnd ?? Number.POSITIVE_INFINITY,
      );
      const candidate = findCandidate(
        task,
        minutes,
        deadline,
        input,
        availability,
        busy,
        sessions,
        dependencyPlan,
        tasksById,
        demandingByDay,
        durations.length > 1,
        constrainedEarliestStart,
        dependencyStart.latestStart,
        index === durations.length - 1 ? earliestDependencyEnd : undefined,
        conditionalContext,
        totalRequestedMinutes,
      );
      if (!candidate) {
        unscheduledMinutes += minutes;
        continue;
      }
      const conditionalExtra = Math.max(0, candidate.minutes - minutes);
      conditionalQuotaExtraMinutes += conditionalExtra;
      if (newlyPlannedMinutes + candidate.minutes > capacityBudget) {
        unscheduledMinutes +=
          candidate.minutes +
          durations
            .slice(index + 1)
            .reduce((sum, duration) => sum + duration, 0);
        break;
      }
      if (sequence || dependencyStart.constrained || latestDependencyEnd !== undefined) {
        candidate.reasons.push("SEQUENCE_ORDER");
      }
      const sessionId = uniqueSessionId(
        `session-${task.id}-${index + 1}`,
        sessions,
      );
      const session: PlannedSession = {
        id: sessionId,
        taskId: task.id ?? task.title,
        title: task.title,
        start: new Date(candidate.start).toISOString(),
        end: new Date(candidate.end).toISOString(),
        minutes: candidate.minutes,
        status: "proposed",
        locked: false,
        reasonCodes: candidate.reasons,
        explanation: explainReasons(candidate.reasons),
      };
      sessions.push(session);
      insertBusyInterval(busy, {
        start: candidate.start,
        end: candidate.end,
      });
      newlyPlannedMinutes += candidate.minutes;
      if (task.energyDemand === "high") {
        const day = localParts(
          candidate.start,
          input.preferences.timeZone,
        ).date;
        demandingByDay.set(day, (demandingByDay.get(day) ?? 0) + 1);
        const breakStart = candidate.end;
        const breakEnd =
          breakStart + input.preferences.preferredBreakMinutes * MINUTE;
        insertBusyInterval(busy, { start: breakStart, end: breakEnd });
        breaks.push({
          afterSessionId: sessionId,
          start: new Date(breakStart).toISOString(),
          end: new Date(breakEnd).toISOString(),
          minutes: input.preferences.preferredBreakMinutes,
        });
      }
    }

    if (unscheduledMinutes > 0) {
      const deadline = Math.min(
        taskDeadline(task, input),
        latestDependencyEnd ?? Number.POSITIVE_INFINITY,
      );
      const hasCapacity = availableCapacityBefore(
        deadline,
        availability,
        busy,
      );
      unschedulableTasks.push(
        unschedulable(
          task,
          unscheduledMinutes,
          hasCapacity < minimum
            ? task.dueDate ||
              task.dueWindow ||
              task.dueAt ||
              latestDependencyEnd !== undefined
              ? "NO_VALID_TIME_BEFORE_DEADLINE"
              : "MINIMUM_SESSION_TOO_LARGE"
            : "INSUFFICIENT_CAPACITY",
        ),
      );
      failedTaskIds.add(taskId);
      if (progress) progress.blocked = true;
    } else if (progress) {
      updateSequenceProgress(progress, task, sessions, input);
    }
  }

  sessions.sort(
    (a, b) =>
      new Date(a.start).getTime() - new Date(b.start).getTime() ||
      a.id.localeCompare(b.id),
  );
  const requiredMinutes = normalizedTasks.reduce((total, task) => {
    if (task.responsibilityKind === "milestone") return total;
    if (task.recurrence?.mode === "fixed_times") {
      return (
        total +
        timedOccurrenceSlots(task, input, conditionalContext).reduce(
          (minutes, slot) => minutes + intervalMinutes(slot),
          0,
        )
      );
    }
    const occurrences =
      task.taskType === "recurring_goal"
        ? Math.max(1, task.recurrence?.count ?? 1)
        : 1;
    return total + (task.estimatedMinutes ?? 0) * occurrences;
  }, conditionalQuotaExtraMinutes);
  const unscheduledMinutes = unschedulableTasks.reduce(
    (total, task) => total + task.unscheduledMinutes,
    0,
  );
  const plannedMinutes = Math.max(0, requiredMinutes - unscheduledMinutes);
  const bufferMinutes = Math.max(0, availableMinutes - newlyPlannedMinutes);
  const fragmentedTaskIds = normalizedTasks
    .filter(
      (task) =>
        sessions.filter((session) => session.taskId === task.id).length >= 4,
    )
    .map((task) => task.id ?? task.title);
  const recurringGoals = normalizedTasks.filter(
    (task) => task.taskType === "recurring_goal",
  );
  const recurringBehind = recurringGoals.filter((task) =>
    unschedulableTasks.some((item) => item.taskId === task.id),
  ).length;
  const overdueTaskIds = new Set(
    normalizedTasks
      .filter((task) => task.responsibilityKind !== "milestone")
      .filter((task) => isOverdueTask(task, input))
      .map((task) => task.id ?? task.title),
  );
  const lateSessionTaskIds = new Set(
    normalizedTasks
      .filter((task) => task.responsibilityKind !== "milestone")
      .filter(
        (task) =>
          task.dueAt ||
          task.dueWindow ||
          task.dueDate ||
          task.recurrence?.windowEnd,
      )
      .filter((task) => {
        const deadline = statedTaskDeadline(task, input);
        return sessions.some(
          (session) =>
            session.taskId === (task.id ?? task.title) &&
            new Date(session.end).getTime() > deadline,
        );
      })
      .map((task) => task.id ?? task.title),
  );
  const deadlineRiskTaskIds = new Set([
    ...overdueTaskIds,
    ...lateSessionTaskIds,
  ]);
  unschedulableTasks.forEach((task) => {
    if (
      ["NO_VALID_TIME_BEFORE_DEADLINE", "INSUFFICIENT_CAPACITY"].includes(
        task.reasonCode,
      )
    ) {
      deadlineRiskTaskIds.add(task.taskId);
    }
  });
  const overdueTaskCount = overdueTaskIds.size;
  const deadlinesAtRisk = deadlineRiskTaskIds.size;
  const scheduledPercent =
    requiredMinutes === 0
      ? 100
      : Math.round((plannedMinutes / requiredMinutes) * 100);
  const riskiest = unschedulableTasks[0];
  const fixedSessions = sessions.filter((session) =>
    isFixedTask(tasksById.get(session.taskId)),
  );
  const overlapWarnings: string[] = [];
  for (let index = 0; index < fixedSessions.length; index += 1) {
    for (let other = index + 1; other < fixedSessions.length; other += 1) {
      const left = fixedSessions[index];
      const right = fixedSessions[other];
      if (
        overlaps(
          { start: new Date(left.start).getTime(), end: new Date(left.end).getTime() },
          { start: new Date(right.start).getTime(), end: new Date(right.end).getTime() },
        )
      ) {
        const warning = `Fixed events overlap: “${left.title}” and “${right.title}”.`;
        if (!overlapWarnings.includes(warning)) overlapWarnings.push(warning);
      }
    }
  }

  return {
    id: "proposal-deterministic-v1",
    sessions,
    breaks,
    unschedulable: unschedulableTasks,
    ...(overlapWarnings.length ? { warnings: overlapWarnings } : {}),
    planHealth: {
      scheduledPercent,
      deadlinesAtRisk,
      unscheduledMinutes,
      bufferMinutesRetained: bufferMinutes,
      demandingFocusBlocks: sessions.filter((session) => {
        const task = normalizedTasks.find((item) => item.id === session.taskId);
        return task?.energyDemand === "high";
      }).length,
      fragmentedTaskIds,
      recurringGoalsOnTrack: recurringGoals.length - recurringBehind,
      recurringGoalsBehind: recurringBehind,
      summary: riskiest
        ? `${scheduledPercent}% of estimated work fits. ${riskiest.title} is at greatest risk, with ${riskiest.unscheduledMinutes} minutes still unplaced.`
        : overdueTaskCount > 0
          ? `All estimated work fits, but ${overdueTaskCount} overdue ${overdueTaskCount === 1 ? "deadline is" : "deadlines are"} still at risk. ${bufferMinutes} minutes remain open for interruptions.`
          : lateSessionTaskIds.size > 0
            ? `All estimated work fits, but ${lateSessionTaskIds.size} ${lateSessionTaskIds.size === 1 ? "deadline is" : "deadlines are"} at risk because confirmed work extends past ${lateSessionTaskIds.size === 1 ? "it" : "them"}. Confirmed placements remain protected.`
          : `All estimated work fits with ${bufferMinutes} minutes left open for interruptions.`,
    },
    availableMinutes,
    plannedMinutes,
    bufferMinutes,
  };
}
