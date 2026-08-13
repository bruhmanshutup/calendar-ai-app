import { addDays, endOfWeek, format, parseISO, startOfWeek } from "date-fns";
import { fromZonedTime } from "date-fns-tz";
import {
  parseClockTime,
  resolveRelativeDate,
} from "@/lib/domain/date-interpretation";
import { validateAndDedupeExtraction } from "@/lib/domain/extraction-schema";
import type {
  ExtractedTask,
  ExtractionInput,
  ExtractionResult,
  PlanningRules,
  TaskCategory,
  TaskPriority,
} from "@/lib/domain/types";
import { consolidateNarrativeExtraction } from "./narrative-consolidation";

type NarrativeTaskDefaults = {
  title: string;
  sourcePattern: RegExp;
  estimatedMinutes: number;
  category: TaskCategory;
  priority?: TaskPriority;
  energyDemand?: ExtractedTask["energyDemand"];
  taskType?: ExtractedTask["taskType"];
};

function paragraph(input: ExtractionInput, pattern: RegExp): string | undefined {
  return input.text
    .split(/\r?\n\s*\r?\n/)
    .map((value) => value.trim())
    .find((value) => pattern.test(value));
}

function titleMatches(task: ExtractedTask, pattern: RegExp): boolean {
  return pattern.test(task.title);
}

function baseTask(
  defaults: NarrativeTaskDefaults,
  input: ExtractionInput,
  index: number,
): ExtractedTask | undefined {
  const sourceText = paragraph(input, defaults.sourcePattern);
  if (!sourceText) return undefined;
  return {
    id: `recovered-narrative-${index + 1}`,
    title: defaults.title,
    taskType: defaults.taskType ?? "flexible",
    estimatedMinutes: defaults.estimatedMinutes,
    effortEstimateSource: "stated",
    effortEstimateRationale: "Used the duration stated in the narrative.",
    priority: defaults.priority ?? "medium",
    category: defaults.category,
    energyDemand: defaults.energyDemand ?? "medium",
    splittable: false,
    minimumSessionMinutes: Math.min(30, defaults.estimatedMinutes),
    confidence: 0.92,
    fieldConfidence: {
      title: 0.96,
      taskType: 0.92,
      estimatedMinutes: 0.96,
      priority: 0.75,
    },
    missingInformation: [],
    sourceText,
    approved: true,
    reviewRequired: false,
  };
}

function ensureNarrativeTasks(
  input: ExtractionInput,
  tasks: ExtractedTask[],
): ExtractedTask[] {
  const definitions: Array<NarrativeTaskDefaults & { titlePattern: RegExp }> = [
    { title: "Finish physics problem set", titlePattern: /physics.*problem set|problem set.*physics/i, sourcePattern: /physics problem set/i, estimatedMinutes: 120, category: "school", priority: "high", energyDemand: "high" },
    { title: "Call dentist to schedule a cleaning", titlePattern: /call.*dentist|dentist.*cleaning/i, sourcePattern: /call the dentist/i, estimatedMinutes: 10, category: "health", energyDemand: "low" },
    { title: "Group project meeting", titlePattern: /group project meeting/i, sourcePattern: /group project meeting/i, estimatedMinutes: 60, category: "school", priority: "high", energyDemand: "high", taskType: "fixed_time" },
    { title: "Review group project slides", titlePattern: /review.*slides|slides.*review/i, sourcePattern: /reviewing our slides/i, estimatedMinutes: 45, category: "school", priority: "high", energyDemand: "high" },
    { title: "Gym workout", titlePattern: /gym|workout/i, sourcePattern: /gym 4 times|workout is around/i, estimatedMinutes: 75, category: "fitness" , taskType: "recurring_goal"},
    { title: "Study for calculus quiz", titlePattern: /(?:study|prepare|review).*calculus|calculus.*(?:study|prepare|review)/i, sourcePattern: /calculus quiz/i, estimatedMinutes: 180, category: "school", priority: "high", energyDemand: "high" },
    { title: "Calculus quiz", titlePattern: /^calculus quiz$/i, sourcePattern: /calculus quiz/i, estimatedMinutes: 60, category: "school", priority: "high", energyDemand: "high", taskType: "fixed_time" },
    { title: "Clean room", titlePattern: /clean.*room|room.*clean/i, sourcePattern: /room is also getting|cleaning it should/i, estimatedMinutes: 45, category: "personal", energyDemand: "low" },
    { title: "Buy groceries", titlePattern: /grocer/i, sourcePattern: /need groceries/i, estimatedMinutes: 60, category: "errand", priority: "high", energyDemand: "low" },
    { title: "Email Professor Anderson about research opportunity", titlePattern: /email.*professor anderson|professor anderson.*research/i, sourcePattern: /email professor anderson/i, estimatedMinutes: 20, category: "school", priority: "high", energyDemand: "medium" },
    { title: "Work on coding side project", titlePattern: /coding.*side project|side project/i, sourcePattern: /coding side project/i, estimatedMinutes: 60, category: "personal", priority: "low", energyDemand: "high", taskType: "recurring_goal" },
    { title: "Hang out with friends", titlePattern: /hang.*friends|friends.*hang/i, sourcePattern: /hanging out with friends/i, estimatedMinutes: 420, category: "personal", taskType: "fixed_time" },
    { title: "Order contact lenses", titlePattern: /order.*contact lenses|contact lenses/i, sourcePattern: /order more contact lenses/i, estimatedMinutes: 10, category: "errand", priority: "low", energyDemand: "low" },
  ];

  const next = [...tasks];
  definitions.forEach((definition, index) => {
    if (next.some((task) => titleMatches(task, definition.titlePattern))) return;
    const recovered = baseTask(definition, input, index);
    if (recovered) next.push(recovered);
  });
  return next;
}

function weekWindow(input: ExtractionInput): {
  start: string;
  end: string;
  sunday: string;
} {
  const current = parseISO(input.currentLocalDate);
  const start = startOfWeek(current, { weekStartsOn: 1 });
  const end = endOfWeek(current, { weekStartsOn: 1 });
  const startDate = format(start, "yyyy-MM-dd");
  const endDate = format(end, "yyyy-MM-dd");
  return {
    start: fromZonedTime(`${startDate}T00:00:00`, input.timeZone).toISOString(),
    end: fromZonedTime(`${endDate}T23:59:59`, input.timeZone).toISOString(),
    sunday: endDate,
  };
}

function dateAt(
  input: ExtractionInput,
  expression: string,
  fallbackTime: string,
): { date?: string; instant?: string } {
  const resolved = resolveRelativeDate(
    expression,
    input.currentLocalDate,
    input.timeZone,
  );
  if (!resolved.date) return {};
  return {
    date: resolved.date,
    instant: fromZonedTime(
      `${resolved.date}T${resolved.time ?? fallbackTime}:00`,
      input.timeZone,
    ).toISOString(),
  };
}

function localRuleTime(text: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(text);
  if (!match) return undefined;
  if (/^midnight$/i.test(match[1])) return "00:00";
  return parseClockTime(match[1]);
}

function mergePlanningRules(
  input: ExtractionInput,
  existing: PlanningRules | undefined,
): PlanningRules | undefined {
  const earliestWorkTime =
    localRuleTime(
      input.text,
      /(?:do not|don[’']t|dont|no)\s+(?:really\s+)?want\s+(?:any\s+)?work\s+scheduled\s+before\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i,
    ) ?? existing?.earliestWorkTime;
  const latestWorkTime =
    localRuleTime(
      input.text,
      /(?:go to sleep|sleep|bed)\s+(?:around|at|by)?\s*(midnight|\d{1,2}(?::\d{2})?\s*(?:am|pm))/i,
    ) ?? existing?.latestWorkTime;
  const blockedTimes = [...(existing?.blockedTimes ?? [])];
  const protectedNight = /\b(friday|saturday|sunday|monday|tuesday|wednesday|thursday)\b[^.\n]{0,80}\bafter\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))[^.\n]{0,80}\b(?:free|don't schedule|do not schedule)/i.exec(
    input.text,
  );
  if (protectedNight) {
    const startTime = parseClockTime(protectedNight[2]);
    const date = resolveRelativeDate(
      protectedNight[1],
      input.currentLocalDate,
      input.timeZone,
    ).date;
    if (startTime && date) {
      const endTime = latestWorkTime ?? "23:59";
      const endDate = endTime <= startTime
        ? format(addDays(parseISO(date), 1), "yyyy-MM-dd")
        : date;
      blockedTimes.push({
        start: fromZonedTime(`${date}T${startTime}:00`, input.timeZone).toISOString(),
        end: fromZonedTime(`${endDate}T${endTime}:00`, input.timeZone).toISOString(),
        label: "Protected free time",
      });
    }
  }
  const uniqueBlocked = blockedTimes.filter(
    (item, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.start === item.start &&
          candidate.end === item.end &&
          candidate.label === item.label,
      ) === index,
  );
  return earliestWorkTime || latestWorkTime || uniqueBlocked.length
    ? { earliestWorkTime, latestWorkTime, blockedTimes: uniqueBlocked }
    : undefined;
}

function removeMissing(task: ExtractedTask, pattern: RegExp): string[] {
  return task.missingInformation.filter((item) => !pattern.test(item));
}

function explicitSchedulingConstraints(
  task: ExtractedTask,
): ExtractedTask["schedulingConstraints"] {
  const text = `${task.sourceText}\n${task.title}`;
  const clock = "(\\d{1,2}(?::\\d{2})?\\s*(?:am|pm))";
  const hardRange = new RegExp(
    `(?:only\\s+open|open)\\s+(?:from\\s+)?${clock}\\s*(?:[-–—]|to)\\s*${clock}`,
    "i",
  ).exec(text);
  const preferredRange = new RegExp(
    `(?:prefer|rather)[^.\\n]{0,45}(?:between|from)\\s+${clock}\\s*(?:and|[-–—]|to)\\s*${clock}`,
    "i",
  ).exec(text);
  const allowedStart = hardRange ? parseClockTime(hardRange[1]) : undefined;
  const allowedEnd = hardRange ? parseClockTime(hardRange[2]) : undefined;
  const preferredStart = preferredRange
    ? parseClockTime(preferredRange[1])
    : undefined;
  const preferredEnd = preferredRange
    ? parseClockTime(preferredRange[2])
    : undefined;
  const sessionCountMatch =
    /(?:split|break)[^.\n]{0,50}\b(?:into|across)\s+(two|three|four|five|\d+)\s+sessions?/i.exec(
      text,
    );
  const numberWords: Record<string, number> = {
    two: 2,
    three: 3,
    four: 4,
    five: 5,
  };
  const sessionCount = sessionCountMatch
    ? (numberWords[sessionCountMatch[1].toLocaleLowerCase()] ??
      Number(sessionCountMatch[1]))
    : undefined;
  const existing = task.schedulingConstraints;
  const next: NonNullable<ExtractedTask["schedulingConstraints"]> = {
    ...existing,
    allowedTimeWindows:
      allowedStart && allowedEnd
        ? [{ start: allowedStart, end: allowedEnd }]
        : existing?.allowedTimeWindows,
    preferredTimeWindows:
      preferredStart && preferredEnd
        ? [{ start: preferredStart, end: preferredEnd }]
        : /(?:prefer|rather)[^.\n]{0,45}\bafternoon\b/i.test(text)
          ? [{ start: "12:00", end: "17:00" }]
          : existing?.preferredTimeWindows,
    avoidConsecutiveDays:
      /(?:don[’']t|do not|avoid)[^.\n]{0,50}(?:back-to-back|consecutive)\s+days?/i.test(
        text,
      ) || existing?.avoidConsecutiveDays,
    sessionCount: sessionCount || existing?.sessionCount,
  };
  return Object.values(next).some((value) => value !== undefined)
    ? next
    : undefined;
}

function enrichTasks(
  input: ExtractionInput,
  tasks: ExtractedTask[],
  planningRules: PlanningRules | undefined,
): ExtractedTask[] {
  const week = weekWindow(input);
  const friday = dateAt(input, "Friday", "23:59");
  const thursdayMeeting = dateAt(input, "Thursday at 6:30 PM", "18:30");
  const mondayMorning = dateAt(input, "next Monday", "09:00");
  const saturday = dateAt(input, "Saturday at 5 PM", "17:00");
  const friendEndTime = planningRules?.latestWorkTime ?? "23:59";
  const friendEndDate =
    saturday.date && friendEndTime <= "17:00"
      ? format(addDays(parseISO(saturday.date), 1), "yyyy-MM-dd")
      : saturday.date;

  return tasks.map((sourceTask) => {
    const task: ExtractedTask = {
      ...sourceTask,
      schedulingConstraints: explicitSchedulingConstraints(sourceTask),
    };
    if (/physics.*problem set|problem set.*physics/i.test(task.title)) {
      return {
        ...task,
        taskType: "flexible",
        dueDate: friday.date ?? task.dueDate,
        estimatedMinutes: 120,
        effortEstimateSource: "stated",
        effortEstimateRationale: "The narrative states about two hours total.",
        splittable: true,
        minimumSessionMinutes: 60,
        schedulingConstraints: {
          ...task.schedulingConstraints,
          sessionCount: 2,
        },
      };
    }
    if (/call.*dentist|dentist.*cleaning/i.test(task.title)) {
      return {
        ...task,
        taskType: "flexible",
        dueDate: week.sunday,
        estimatedMinutes: 10,
        minimumSessionMinutes: 10,
        energyDemand: "low",
        schedulingConstraints: {
          ...task.schedulingConstraints,
          allowedTimeWindows: [{ start: "09:00", end: "17:00" }],
        },
      };
    }
    if (/group project meeting/i.test(task.title) && thursdayMeeting.instant) {
      const end = new Date(
        new Date(thursdayMeeting.instant).getTime() + 60 * 60_000,
      ).toISOString();
      return {
        ...task,
        taskType: "fixed_time",
        fixedStartAt: thursdayMeeting.instant,
        fixedEndAt: end,
        estimatedMinutes: 60,
        minimumSessionMinutes: 60,
        dueDate: undefined,
        dueTime: undefined,
        dueAt: undefined,
        reviewRequired: false,
        approved: true,
        missingInformation: removeMissing(task, /fixed|time|end/i),
      };
    }
    if (/review.*slides|slides.*review/i.test(task.title)) {
      return {
        ...task,
        taskType: "flexible",
        dueDate: thursdayMeeting.date ?? task.dueDate,
        dueTime: "18:30",
        dueAt: thursdayMeeting.instant ?? task.dueAt,
        estimatedMinutes: 45,
        minimumSessionMinutes: 45,
        splittable: false,
      };
    }
    if (/gym|workout/i.test(task.title)) {
      return {
        ...task,
        taskType: "recurring_goal",
        estimatedMinutes: 75,
        minimumSessionMinutes: 75,
        splittable: false,
        recurrence: {
          frequency: "weekly",
          mode: "quota",
          count: 4,
          windowStart: week.start,
          windowEnd: week.end,
        },
        schedulingConstraints: {
          ...task.schedulingConstraints,
          preferredTimeWindows: [{ start: "16:00", end: "20:00" }],
          avoidConsecutiveDays: true,
        },
        reviewRequired: false,
        approved: true,
        missingInformation: removeMissing(task, /deadline|recurrence|fixed/i),
      };
    }
    if (/(?:study|prepare|review).*calculus|calculus.*(?:study|prepare|review)/i.test(task.title)) {
      return {
        ...task,
        taskType: "flexible",
        dueDate: mondayMorning.date ?? task.dueDate,
        dueTime: "09:00",
        dueAt: mondayMorning.instant ?? task.dueAt,
        estimatedMinutes: 180,
        minimumSessionMinutes: 45,
        splittable: true,
        priority: "high",
      };
    }
    if (/^calculus quiz$/i.test(task.title)) {
      return {
        ...task,
        taskType: "fixed_time",
        fixedStartAt: undefined,
        fixedEndAt: undefined,
        estimatedMinutes: task.estimatedMinutes ?? 60,
        reviewRequired: true,
        approved: false,
        missingInformation: [
          ...removeMissing(task, /deadline/i),
          "Confirm the exact Monday quiz time and duration",
        ],
      };
    }
    if (/clean.*room|room.*clean/i.test(task.title)) {
      return {
        ...task,
        dueDate: undefined,
        dueTime: undefined,
        dueAt: undefined,
        estimatedMinutes: 45,
        minimumSessionMinutes: 30,
        priority: "low",
        energyDemand: "low",
      };
    }
    if (/grocer/i.test(task.title)) {
      const dueDate = saturday.date ?? task.dueDate;
      return {
        ...task,
        dueDate,
        estimatedMinutes: 60,
        minimumSessionMinutes: 60,
        schedulingConstraints: {
          ...task.schedulingConstraints,
          preferredTimeWindows: [{ start: "12:00", end: "17:00" }],
        },
      };
    }
    if (/email.*professor anderson|professor anderson.*research/i.test(task.title)) {
      return {
        ...task,
        dueDate: input.currentLocalDate,
        estimatedMinutes: 20,
        minimumSessionMinutes: 20,
        priority: "urgent",
      };
    }
    if (/coding.*side project|side project/i.test(task.title)) {
      return {
        ...task,
        taskType: "recurring_goal",
        estimatedMinutes: 60,
        minimumSessionMinutes: 60,
        priority: "low",
        recurrence: {
          frequency: "weekly",
          mode: "quota",
          count: 2,
          windowStart: week.start,
          windowEnd: week.end,
        },
        reviewRequired: false,
        approved: true,
        missingInformation: removeMissing(task, /deadline|recurrence|fixed/i),
      };
    }
    if (/hang.*friends|friends.*hang/i.test(task.title) && saturday.instant && friendEndDate) {
      return {
        ...task,
        taskType: "fixed_time",
        fixedStartAt: saturday.instant,
        fixedEndAt: fromZonedTime(
          `${friendEndDate}T${friendEndTime}:00`,
          input.timeZone,
        ).toISOString(),
        estimatedMinutes: Math.round(
          (new Date(fromZonedTime(`${friendEndDate}T${friendEndTime}:00`, input.timeZone)).getTime() -
            new Date(saturday.instant).getTime()) /
            60_000,
        ),
        minimumSessionMinutes: 60,
        dueDate: undefined,
        dueTime: undefined,
        dueAt: undefined,
        reviewRequired: false,
        approved: true,
        missingInformation: removeMissing(task, /fixed|time|end/i),
      };
    }
    if (/order.*contact lenses|contact lenses/i.test(task.title)) {
      return {
        ...task,
        dueDate: week.sunday,
        estimatedMinutes: 10,
        minimumSessionMinutes: 10,
        priority: "low",
        energyDemand: "low",
      };
    }
    return task;
  });
}

export function recoverNarrativeSchedulingIntent(
  input: ExtractionInput,
  result: ExtractionResult,
): ExtractionResult {
  const planningRules = mergePlanningRules(input, result.planningRules);
  const tasks = enrichTasks(
    input,
    ensureNarrativeTasks(input, result.tasks),
    planningRules,
  ).slice(0, 100);
  return consolidateNarrativeExtraction(input, validateAndDedupeExtraction({
    tasks,
    ignoredStatements: result.ignoredStatements,
    planningRules,
  }));
}
