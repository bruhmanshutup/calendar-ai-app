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
  localDate: string;
  adjacentTaskDay?: boolean;
  score: number;
  reasons: ScheduleReasonCode[];
};

type SequenceProgress = {
  blocked: boolean;
  lastDate?: string;
};

type TimedOccurrence = NumericInterval & { date: string; time: string };

type LocalParts = { date: string; minutes: number; weekday: string };

type CandidateDayLoad = {
  sessionCount: number;
  minutes: number;
  taskOccurrences: number;
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
  taskSessions: PlannedSession[],
  timeZone: string,
): boolean {
  const recurrence = task.recurrence;
  if (task.taskType !== "recurring_goal" || !recurrence) return true;

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
  if (!task.dueAt && !task.dueDate) return false;
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

function tasksInSchedulingOrder(
  tasks: ExtractedTask[],
  input: SchedulingInput,
  availability: NumericInterval[],
  busy: NumericInterval[],
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
  while (ready.length > 0) {
    ready.sort(
      (first, second) =>
        (riskByTask.get(second.task) ?? 0) -
          (riskByTask.get(first.task) ?? 0) ||
        (first.task.id ?? "").localeCompare(second.task.id ?? ""),
    );
    const next = ready.shift();
    if (!next) break;
    ordered.push(next.task);
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

function timedOccurrenceSlots(
  task: ExtractedTask,
  input: SchedulingInput,
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
      const duration = task.estimatedMinutes ?? 0;
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

function taskTargetStart(
  task: ExtractedTask,
  deadline: number,
  input: SchedulingInput,
): number {
  const windowStart = new Date(input.windowStart).getTime();
  const windowEnd = new Date(input.windowEnd).getTime();
  const targetFraction =
    task.schedulingConstraints?.avoidConsecutiveDays ||
    (task.taskType === "recurring_goal" && (task.recurrence?.interval ?? 1) > 1)
      ? 0
      : task.dueAt || task.dueDate
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
  demandingByDay: Map<string, number>,
  wasSplit: boolean,
  earliestStart?: number,
  searchAllGenericAvailability = false,
): Candidate | undefined {
  const mode = PLANNING_MODE_CONFIG[input.preferences.planningMode];
  const taskSessions = sessions.filter((session) => session.taskId === task.id);
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
    !task.dueDate &&
    !task.recurrence &&
    !taskSequence(task) &&
    !task.schedulingConstraints?.allowedTimeWindows?.length &&
    !task.schedulingConstraints?.avoidConsecutiveDays;
  const genericTarget = canLimitGenericSearch
    ? taskTargetStart(task, deadline, input)
    : undefined;
  const requestedMinutes = input.tasks.reduce(
    (total, item) =>
      total +
      (item.estimatedMinutes ?? 0) * Math.max(1, item.recurrence?.count ?? 1),
    0,
  );
  const genericAvailabilityRange =
    genericTarget === undefined
      ? undefined
      : availabilityRangeForCapacity(
          availability,
          genericTarget,
          requestedMinutes / Math.max(0.05, 1 - mode.bufferRatio),
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
            minutes,
            deadline,
            input,
            { start: intervalStart, end: Math.min(interval.end, deadline) },
            busy,
            breakMinutes,
          )
        : denseCandidateStarts(ceilToIncrement(intervalStart), lastStart);
    for (const start of candidateStarts) {
      const end = start + minutes * MINUTE;
      const slot = { start, end };
      const local = localParts(start, input.preferences.timeZone);
      const breakSlot = {
        start: end,
        end: end + breakMinutes * MINUTE,
      };
      const recurrenceStart = task.recurrence?.windowStart
        ? new Date(task.recurrence.windowStart).getTime()
        : Number.NEGATIVE_INFINITY;
      if (
        (earliestStart !== undefined && start < earliestStart) ||
        start < recurrenceStart ||
        !quotaRecurrenceAllowsDate(
          task,
          local.date,
          taskSessions,
          input.preferences.timeZone,
        )
      ) {
        continue;
      }
      if (
        task.schedulingConstraints?.allowedTimeWindows?.length &&
        !task.schedulingConstraints.allowedTimeWindows.some((window) =>
          sessionFitsClockWindow(local.minutes, minutes, window),
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
          sessionFitsClockWindow(local.minutes, minutes, window),
        ) ||
        task.schedulingConstraints?.preferredTimeWindows?.some((window) =>
          sessionFitsClockWindow(local.minutes, minutes, window),
        )
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
        localDate: local.date,
        adjacentTaskDay,
        score: candidateScore(
          task,
          start,
          deadline,
          input,
          local,
          dayLoads.get(local.date),
          minutes,
          adjacentTaskDay,
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
      demandingByDay,
      wasSplit,
      earliestStart,
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
  const availability = mergeIntervals(input.availability.map(toNumeric));
  const baseBusy = mergeIntervals(
    [
      ...input.unavailableEvents,
      ...input.blockedTimes,
      ...input.lockedSessions.map((session) => ({
        start: session.start,
        end: session.end,
      })),
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

  const normalizedTasks = tasksInSchedulingOrder(
    input.tasks.map((task, index) => ({
      ...task,
      id: task.id ?? `task-${index + 1}`,
    })),
    input,
    availability,
    busy,
  );
  const sequenceProgress = new Map<string, SequenceProgress>();

  for (const task of normalizedTasks) {
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
        continue;
      }
    }
    const earliestSequenceStart =
      sequence && progress
        ? sequenceEarliestStart(sequence, progress, input)
        : undefined;
    if (
      task.reviewRequired ||
      (task.taskType === "fixed_time" &&
        (!task.fixedStartAt || !task.fixedEndAt)) ||
      estimate <= 0
    ) {
      unschedulableTasks.push(
        unschedulable(task, estimate, "MISSING_REQUIRED_INFORMATION"),
      );
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
        (earliestSequenceStart !== undefined &&
          start < earliestSequenceStart) ||
        !explicitTimeIsAllowed(slot, input, availability) ||
        !isFree(slot, busy)
      ) {
        unschedulableTasks.push(
          unschedulable(task, minutes || estimate, "FIXED_TIME_CONFLICT"),
        );
        if (progress) progress.blocked = true;
        continue;
      }
      const reasons: ScheduleReasonCode[] = sequence
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
        explanation: explainReasons(reasons),
      };
      sessions.push(session);
      insertBusyInterval(busy, slot);
      newlyPlannedMinutes += minutes;
      if (progress) updateSequenceProgress(progress, task, sessions, input);
      continue;
    }

    if (task.recurrence?.mode === "fixed_times") {
      const occurrences = timedOccurrenceSlots(task, input);
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
          (earliestSequenceStart !== undefined &&
            slot.start < earliestSequenceStart) ||
          !explicitTimeIsAllowed(slot, input, availability) ||
          !isFree(slot, busy)
        ) {
          conflictedMinutes += minutes;
          continue;
        }
        const reasons: ScheduleReasonCode[] = sequence
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
    if (minimum > input.preferences.maximumBlockMinutes) {
      unschedulableTasks.push(
        unschedulable(task, remainingMinutes, "MINIMUM_SESSION_TOO_LARGE"),
      );
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
              input.preferences.maximumBlockMinutes,
            ) ?? chunkDurations(
              remainingMinutes,
              input.preferences.preferredBlockMinutes,
              input.preferences.maximumBlockMinutes,
              minimum,
            ))
          : [remainingMinutes];
    if (
      !task.splittable &&
      task.taskType !== "recurring_goal" &&
      remainingMinutes > input.preferences.maximumBlockMinutes
    ) {
      unschedulableTasks.push(
        unschedulable(task, remainingMinutes, "MINIMUM_SESSION_TOO_LARGE"),
      );
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
      const deadline = taskDeadline(task, input);
      const candidate = findCandidate(
        task,
        minutes,
        deadline,
        input,
        availability,
        busy,
        sessions,
        demandingByDay,
        durations.length > 1,
        earliestSequenceStart,
      );
      if (!candidate) {
        unscheduledMinutes += minutes;
        continue;
      }
      if (sequence) candidate.reasons.push("SEQUENCE_ORDER");
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
        minutes,
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
      newlyPlannedMinutes += minutes;
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
      const deadline = taskDeadline(task, input);
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
            ? task.dueDate || task.dueAt
              ? "NO_VALID_TIME_BEFORE_DEADLINE"
              : "MINIMUM_SESSION_TOO_LARGE"
            : "INSUFFICIENT_CAPACITY",
        ),
      );
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
    if (task.recurrence?.mode === "fixed_times") {
      return (
        total +
        timedOccurrenceSlots(task, input).reduce(
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
  }, 0);
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
      .filter((task) => isOverdueTask(task, input))
      .map((task) => task.id ?? task.title),
  );
  const lateSessionTaskIds = new Set(
    normalizedTasks
      .filter(
        (task) => task.dueAt || task.dueDate || task.recurrence?.windowEnd,
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

  return {
    id: "proposal-deterministic-v1",
    sessions,
    breaks,
    unschedulable: unschedulableTasks,
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
