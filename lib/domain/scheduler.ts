import {
  PLANNING_MODE_CONFIG,
  PRIORITY_WEIGHT,
  SCHEDULER_INCREMENT_MINUTES,
} from "./config";
import { dateOnlyPlanningDeadline } from "./date-interpretation";
import { explainReasons } from "./explanations";
import type {
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

type NumericInterval = { start: number; end: number };

type Candidate = {
  start: number;
  end: number;
  score: number;
  reasons: ScheduleReasonCode[];
};

function toNumeric(interval: TimeInterval): NumericInterval {
  return {
    start: new Date(interval.start).getTime(),
    end: new Date(interval.end).getTime(),
  };
}

function intervalMinutes(interval: NumericInterval): number {
  return Math.max(0, Math.round((interval.end - interval.start) / MINUTE));
}

function overlaps(a: NumericInterval, b: NumericInterval): boolean {
  return a.start < b.end && b.start < a.end;
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

function isFree(
  candidate: NumericInterval,
  busy: NumericInterval[],
): boolean {
  return !busy.some((interval) => overlaps(candidate, interval));
}

function ceilToIncrement(value: number): number {
  const increment = SCHEDULER_INCREMENT_MINUTES * MINUTE;
  return Math.ceil(value / increment) * increment;
}

function localParts(
  instant: number,
  timeZone: string,
): { date: string; minutes: number; weekday: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    minutes: Number(value("hour")) * 60 + Number(value("minute")),
    weekday: value("weekday").toLocaleLowerCase(),
  };
}

function clockMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
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
    const occupied = busy.reduce((busyTotal, event) => {
      const start = Math.max(clipped.start, event.start);
      const end = Math.min(clipped.end, event.end);
      return busyTotal + Math.max(0, Math.round((end - start) / MINUTE));
    }, 0);
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

function candidateScore(
  task: ExtractedTask,
  start: number,
  deadline: number,
  input: SchedulingInput,
  sessions: PlannedSession[],
): number {
  const mode = PLANNING_MODE_CONFIG[input.preferences.planningMode];
  const local = localParts(start, input.preferences.timeZone);
  const focusMatch = input.preferences.preferredFocusWindows.some((window) =>
    isInClockWindow(local.minutes, window),
  );
  const routineMatch = input.preferences.preferredRoutineWindows.some(
    (window) => isInClockWindow(local.minutes, window),
  );
  const sameDaySessions = sessions.filter(
    (session) =>
      localParts(
        new Date(session.start).getTime(),
        input.preferences.timeZone,
      ).date === local.date,
  );
  const sameTaskDayOccurrences = sameDaySessions.filter(
    (session) => session.taskId === task.id,
  ).length;
  const sameDayMinutes = sameDaySessions.reduce(
    (total, session) => total + session.minutes,
    0,
  );
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

  const targetFraction = task.dueAt || task.dueDate
    ? task.priority === "urgent"
      ? 0.2
      : task.priority === "high"
        ? 0.3
        : task.priority === "medium"
          ? 0.45
          : 0.6
    : 0.25;
  const targetDeadline = Math.min(deadline, windowEnd);
  const targetStart =
    windowStart + Math.max(0, targetDeadline - windowStart) * targetFraction;
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
    (sameDayMinutes * 0.45 + sameDaySessions.length * 20) *
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
  if (task.taskType === "recurring_goal") {
    score -= sameTaskDayOccurrences * 70;
  }
  score += mode.densityWeight;
  return score;
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
): Candidate | undefined {
  const mode = PLANNING_MODE_CONFIG[input.preferences.planningMode];
  const taskSessions = sessions.filter((session) => session.taskId === task.id);
  const candidates: Candidate[] = [];
  const increment = SCHEDULER_INCREMENT_MINUTES * MINUTE;
  const breakMinutes =
    task.energyDemand === "high" ? input.preferences.preferredBreakMinutes : 0;

  for (const interval of availability) {
    for (
      let start = ceilToIncrement(interval.start);
      start + minutes * MINUTE <= Math.min(interval.end, deadline);
      start += increment
    ) {
      const end = start + minutes * MINUTE;
      const slot = { start, end };
      const local = localParts(start, input.preferences.timeZone);
      const breakSlot = {
        start: end,
        end: end + breakMinutes * MINUTE,
      };
      if (
        task.taskType === "recurring_goal" &&
        taskSessions.some(
          (session) =>
            localParts(
              new Date(session.start).getTime(),
              input.preferences.timeZone,
            ).date === local.date,
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
      if (!isInside(slot, availability) || !isFree(slot, busy)) continue;
      if (
        breakMinutes > 0 &&
        (!isInside(breakSlot, availability) || !isFree(breakSlot, busy))
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
      candidates.push({
        start,
        end,
        score: candidateScore(task, start, deadline, input, sessions),
        reasons: [...new Set(reasons)],
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.start - b.start);
  return candidates[0];
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
    const occupied = busy.reduce((busyTotal, event) => {
      const start = Math.max(interval.start, event.start);
      const end = Math.min(interval.end, event.end);
      return busyTotal + Math.max(0, Math.round((end - start) / MINUTE));
    }, 0);
    return total + Math.max(0, intervalMinutes(interval) - occupied);
  }, 0);
}

export function generateSchedule(input: SchedulingInput): ScheduleProposal {
  const availability = input.availability
    .map(toNumeric)
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start);
  const baseBusy = [
    ...input.unavailableEvents,
    ...input.blockedTimes,
    ...input.lockedSessions.map((session) => ({
      start: session.start,
      end: session.end,
    })),
  ]
    .map(toNumeric)
    .sort((a, b) => a.start - b.start);
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

  const normalizedTasks = input.tasks
    .map((task, index) => ({ ...task, id: task.id ?? `task-${index + 1}` }))
    .sort(
      (a, b) =>
        taskRisk(b, input, availability, busy) -
          taskRisk(a, input, availability, busy) ||
        (a.id ?? "").localeCompare(b.id ?? ""),
    );

  for (const task of normalizedTasks) {
    const estimate = task.estimatedMinutes ?? 0;
    if (
      task.reviewRequired ||
      (task.taskType === "fixed_time" &&
        (!task.fixedStartAt || !task.fixedEndAt)) ||
      estimate <= 0
    ) {
      unschedulableTasks.push(
        unschedulable(task, estimate, "MISSING_REQUIRED_INFORMATION"),
      );
      continue;
    }

    if (task.taskType === "fixed_time") {
      const start = new Date(task.fixedStartAt ?? "").getTime();
      const end = new Date(task.fixedEndAt ?? "").getTime();
      const slot = { start, end };
      const minutes = intervalMinutes(slot);
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        !isInside(slot, availability) ||
        !isFree(slot, busy)
      ) {
        unschedulableTasks.push(
          unschedulable(task, minutes || estimate, "FIXED_TIME_CONFLICT"),
        );
        continue;
      }
      const reasons: ScheduleReasonCode[] = ["FIXED_TIME"];
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
      busy.push(slot);
      newlyPlannedMinutes += minutes;
      continue;
    }

    const occurrences =
      task.taskType === "recurring_goal"
        ? Math.max(1, task.recurrence?.count ?? 1)
        : 1;
    const totalMinutes = estimate * occurrences;
    const minimum =
      task.minimumSessionMinutes ?? SCHEDULER_INCREMENT_MINUTES;
    if (minimum > input.preferences.maximumBlockMinutes) {
      unschedulableTasks.push(
        unschedulable(task, totalMinutes, "MINIMUM_SESSION_TOO_LARGE"),
      );
      continue;
    }
    const durations =
      task.taskType === "recurring_goal"
        ? Array.from({ length: occurrences }, () => estimate)
        : task.splittable
          ? chunkDurations(
              estimate,
              input.preferences.preferredBlockMinutes,
              input.preferences.maximumBlockMinutes,
              minimum,
            )
          : [estimate];
    if (
      !task.splittable &&
      task.taskType !== "recurring_goal" &&
      estimate > input.preferences.maximumBlockMinutes
    ) {
      unschedulableTasks.push(
        unschedulable(task, estimate, "MINIMUM_SESSION_TOO_LARGE"),
      );
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
      );
      if (!candidate) {
        unscheduledMinutes += minutes;
        continue;
      }
      const sessionId = `session-${task.id}-${index + 1}`;
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
      busy.push({ start: candidate.start, end: candidate.end });
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
        busy.push({ start: breakStart, end: breakEnd });
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
    }
  }

  sessions.sort(
    (a, b) =>
      new Date(a.start).getTime() - new Date(b.start).getTime() ||
      a.id.localeCompare(b.id),
  );
  const requiredMinutes = normalizedTasks.reduce((total, task) => {
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
  const deadlinesAtRisk = unschedulableTasks.filter((task) =>
    ["NO_VALID_TIME_BEFORE_DEADLINE", "INSUFFICIENT_CAPACITY"].includes(
      task.reasonCode,
    ),
  ).length;
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
        : `All estimated work fits with ${bufferMinutes} minutes left open for interruptions.`,
    },
    availableMinutes,
    plannedMinutes,
    bufferMinutes,
  };
}
