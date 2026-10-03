import {
  addDays,
  addWeeks,
  differenceInCalendarDays,
  format,
  parseISO,
  startOfWeek,
} from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

import { parseClockTime } from "@/lib/domain/date-interpretation";
import type {
  ClockWindow,
  ExtractedTask,
  ExtractionInput,
  ExtractionResult,
  SourceEvidenceSpan,
  TemporalWindow,
} from "@/lib/domain/types";
import type { SemanticDraft } from "./semantic-draft";
import { normalizeSemanticDraft } from "./semantic-draft-normalization";
import { clockEvidenceForRelativeTask } from "./temporal-evidence";
import { checkQuotedTiming, RELATIONSHIP_REVIEW_MESSAGE, type QuotedTiming } from "./quoted-timing";
import { deriveVerifiedTimes, requireTimingReview } from "./temporal-derivation";
import { calculateAiTiming, isSpecialTiming, specialTimingTaskIds } from "./ai-timing-calculator";

type DraftResponsibility = SemanticDraft["responsibilities"][number];
type DraftWindow = NonNullable<
  NonNullable<DraftResponsibility["constraints"]>["allowedWindows"]
>[number];

const PERIOD_CLOCKS: Array<{
  pattern: RegExp;
  start: string;
  end: string;
}> = [
  { pattern: /early\s+morning/i, start: "06:00", end: "09:00" },
  { pattern: /morning/i, start: "09:00", end: "12:00" },
  { pattern: /afternoon/i, start: "12:00", end: "17:00" },
  { pattern: /evening/i, start: "17:00", end: "21:00" },
  { pattern: /late\s+night/i, start: "21:00", end: "23:59" },
  { pattern: /night/i, start: "20:00", end: "23:59" },
  { pattern: /between\s+classes|daytime/i, start: "09:00", end: "18:00" },
  { pattern: /end\s+of\s+(?:the\s+)?day/i, start: "17:00", end: "23:59" },
];

function localInstant(date: string, time: string, timeZone: string): string {
  return fromZonedTime(`${date}T${time}:00`, timeZone).toISOString();
}

function nextDate(date: string): string {
  return format(addDays(parseISO(date), 1), "yyyy-MM-dd");
}

function localInterval(
  date: string,
  startTime: string,
  endTime: string,
  timeZone: string,
): { start: string; end: string } {
  const endDate = endTime <= startTime ? nextDate(date) : date;
  return {
    start: localInstant(date, startTime, timeZone),
    end: localInstant(endDate, endTime, timeZone),
  };
}

function periodClock(period: string | undefined): {
  start: string;
  end: string;
} | undefined {
  if (!period) return undefined;
  const match = PERIOD_CLOCKS.find(({ pattern }) => pattern.test(period));
  if (match) return { start: match.start, end: match.end };
  if (/weekend/i.test(period)) return { start: "00:00", end: "23:59" };
  if (/early\s+next\s+week|early\s+week/i.test(period)) {
    return { start: "09:00", end: "17:00" };
  }
  return undefined;
}

function resolvedWindow(
  date: string,
  label: string,
  period: string | undefined,
  timeZone: string,
  precision: TemporalWindow["precision"] = "named_period",
): TemporalWindow {
  const clocks = periodClock(period) ?? { start: "00:00", end: "23:59" };
  const interval = localInterval(date, clocks.start, clocks.end, timeZone);
  if (/weekend/i.test(period ?? "")) {
    const sunday = parseISO(date);
    const saturday = format(addDays(sunday, -1), "yyyy-MM-dd");
    return {
      start: localInstant(saturday, "00:00", timeZone),
      end: localInstant(nextDate(date), "00:00", timeZone),
      label,
      precision,
    };
  }
  return { ...interval, label, precision };
}

function draftWindowToTemporal(
  window: DraftWindow,
  fallbackDate: string | undefined,
  timeZone: string,
): TemporalWindow | undefined {
  const date = window.date ?? fallbackDate;
  if (!date) return undefined;
  if (window.startTime || window.endTime) {
    const startTime = window.startTime ?? "00:00";
    const endTime = window.endTime ?? "23:59";
    return {
      ...localInterval(date, startTime, endTime, timeZone),
      label: window.label,
      precision:
        window.startTime && window.endTime ? "exact" : "approximate",
    };
  }
  return resolvedWindow(
    date,
    window.label,
    window.period,
    timeZone,
    window.period ? "named_period" : "approximate",
  );
}

function uniqueTemporalWindows(windows: TemporalWindow[]): TemporalWindow[] {
  const seen = new Set<string>();
  return windows.filter((window) => {
    const key = `${window.start}|${window.end}|${window.precision}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validSourceSpan(
  input: ExtractionInput,
  responsibility: DraftResponsibility,
): SourceEvidenceSpan | undefined {
  const { sourceStart, sourceEnd, sourceText } = responsibility;
  const exactStart = input.text.indexOf(
    sourceText,
    Math.max(0, (sourceStart ?? 0) - 2),
  );
  if (exactStart >= 0) {
    return {
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
      start: exactStart,
      end: exactStart + sourceText.length,
      quote: sourceText,
    };
  }
  if (
    sourceStart !== undefined &&
    sourceEnd !== undefined &&
    sourceEnd > sourceStart &&
    sourceEnd <= input.text.length
  ) {
    const lineStart = input.text.lastIndexOf("\n", Math.max(0, sourceStart - 1)) + 1;
    const nextLine = input.text.indexOf("\n", sourceEnd);
    const lineEnd = nextLine < 0 ? input.text.length : nextLine;
    const line = input.text.slice(lineStart, lineEnd).replace(/\r$/, "");
    const isListItem = /^\s*(?:[-*•]|\d+[.)]|\[[ xX]\])\s+/.test(line);
    const paragraphBreakBefore = input.text.lastIndexOf("\n\n", sourceStart);
    const paragraphStart = paragraphBreakBefore < 0 ? 0 : paragraphBreakBefore + 2;
    const paragraphBreakAfter = input.text.indexOf("\n\n", sourceEnd);
    const paragraphEnd =
      paragraphBreakAfter < 0 ? input.text.length : paragraphBreakAfter;
    const start = isListItem ? lineStart : paragraphStart;
    const end = isListItem ? lineStart + line.length : paragraphEnd;
    const quote = input.text.slice(start, end);
    return {
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
      start,
      end,
      quote,
    };
  }
  const start = input.text.indexOf(sourceText);
  return start < 0
    ? undefined
    : {
        ...(input.sourceId ? { sourceId: input.sourceId } : {}),
        start,
        end: start + sourceText.length,
        quote: sourceText,
      };
}

function validFactEvidenceSpans(
  input: ExtractionInput,
  responsibility: DraftResponsibility,
): SourceEvidenceSpan[] {
  const seen = new Set<string>();
  return (responsibility.factEvidence ?? []).flatMap((item) => {
    const exactAtOffsets =
      item.sourceEnd > item.sourceStart &&
      item.sourceEnd <= input.text.length &&
      input.text.slice(item.sourceStart, item.sourceEnd) === item.sourceText;
    const start = exactAtOffsets ? item.sourceStart : input.text.indexOf(item.sourceText);
    if (start < 0) return [];
    const end = start + item.sourceText.length;
    const key = `${start}|${end}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        ...(input.sourceId ? { sourceId: input.sourceId } : {}),
        start,
        end,
        quote: item.sourceText,
      },
    ];
  });
}

function responsibilityEvidenceText(
  input: ExtractionInput,
  responsibility: DraftResponsibility,
): string {
  return [
    responsibility.sourceText,
    ...validFactEvidenceSpans(input, responsibility).map((span) => span.quote),
  ].join(" ");
}

function inferredCategory(title: string): ExtractedTask["category"] {
  if (/gym|workout|run|exercise|fitness/i.test(title)) return "fitness";
  if (/dentist|doctor|medication|therapy|health/i.test(title)) return "health";
  if (/grocery|groceries|order|pick up|call|errand/i.test(title)) return "errand";
  if (/report|essay|homework|physics|calculus|chemistry|quiz|exam|slides|proposal|cad|study/i.test(title)) {
    return "school";
  }
  return "other";
}

function inferredEnergy(
  category: ExtractedTask["category"],
): ExtractedTask["energyDemand"] {
  if (category === "school" || category === "work") return "high";
  if (category === "errand") return "low";
  return "medium";
}

function inferredPriority(
  input: ExtractionInput,
  responsibility: DraftResponsibility,
): ExtractedTask["priority"] {
  const planned = responsibility.planning?.priority;
  if (planned) return planned;
  const date = responsibility.deadline?.date;
  if (!date || responsibility.deadline?.strength === "soft") return "medium";
  const distance = differenceInCalendarDays(
    parseISO(date),
    parseISO(input.currentLocalDate),
  );
  if (distance <= 0) return "urgent";
  return distance <= 2 ? "high" : "medium";
}

function estimatedMinutes(
  input: ExtractionInput,
  responsibility: DraftResponsibility,
): number {
  const duration = responsibility.duration;
  let stated = duration?.preferredMinutes;
  if (
    stated === undefined &&
    duration?.minimumMinutes !== undefined &&
    duration.maximumMinutes !== undefined &&
    /\b(?:about|around|approximately|roughly)\b/i.test(
      responsibilityEvidenceText(input, responsibility),
    )
  ) {
    // An approximate single duration is normally represented as a tolerance
    // range by the model. Use its midpoint as the planning duration; reserving
    // the maximum is appropriate for an explicit "2-3 hours" style range.
    stated =
      Math.round(
        (duration.minimumMinutes + duration.maximumMinutes) / 2 / 5,
      ) * 5;
  }
  stated ??= duration?.maximumMinutes ?? duration?.minimumMinutes;
  return stated ?? responsibility.planning?.estimatedMinutes ?? 45;
}

function minimumSessionMinutes(
  responsibility: DraftResponsibility,
  estimate: number,
): number {
  const splittable =
    responsibility.planning?.splittable ??
    (responsibility.kind === "task" && estimate >= 90);
  const requested =
    responsibility.planning?.minimumSessionMinutes ??
    (splittable
      ? Math.min(estimate, 30)
      : responsibility.duration?.minimumMinutes ??
        Math.min(estimate, estimate >= 60 ? 30 : 15));
  return Math.max(1, Math.min(240, estimate, requested));
}

function constraintWindows(
  input: ExtractionInput,
  responsibility: DraftResponsibility,
): ExtractedTask["schedulingConstraints"] {
  const constraints = responsibility.constraints ?? {};
  const fallbackDate =
    responsibility.deadline?.date ?? responsibility.occurrence?.date;
  const allowedDateWindows = (constraints.allowedWindows ?? [])
    .map((window) => draftWindowToTemporal(window, fallbackDate, input.timeZone))
    .filter((window): window is TemporalWindow => Boolean(window));
  const preferredDateWindows = (constraints.preferredWindows ?? [])
    .map((window) => draftWindowToTemporal(window, fallbackDate, input.timeZone))
    .filter((window): window is TemporalWindow => Boolean(window));
  const allowedTimeWindows: ClockWindow[] = (constraints.allowedWindows ?? [])
    .filter((window) => !window.date && window.startTime && window.endTime)
    .map((window) => ({ start: window.startTime!, end: window.endTime! }));
  const preferredTimeWindows: ClockWindow[] = (
    constraints.preferredWindows ?? []
  )
    .filter((window) => !window.date && window.startTime && window.endTime)
    .map((window) => ({ start: window.startTime!, end: window.endTime! }));
  const evidence = responsibilityEvidenceText(input, responsibility);

  if (
    preferredTimeWindows.length === 0 &&
    preferredDateWindows.length === 0 &&
    /\b(?:prefer(?:ably)?|ideally|would\s+rather|rather\s+than)\b/i.test(evidence)
  ) {
    if (/\bbetween\s+classes\b/i.test(evidence)) {
      preferredTimeWindows.push({ start: "09:00", end: "18:00" });
    } else if (/\bdaytime\b/i.test(evidence)) {
      preferredTimeWindows.push({ start: "09:00", end: "18:00" });
    } else if (
      /\bprefer(?:ably)?\s+earlier\b/i.test(evidence) &&
      responsibility.deadline?.date
    ) {
      preferredDateWindows.push({
        ...localInterval(
          responsibility.deadline.date,
          "00:00",
          responsibility.deadline.time ?? "23:59",
          input.timeZone,
        ),
        label: "Preferably earlier",
        precision: "approximate",
      });
    }
  }

  const earliest = constraints.earliestStart;
  const latest = constraints.latestEnd;
  const boundaryDate = earliest?.date ?? latest?.date ?? fallbackDate;
  if (boundaryDate && (earliest || latest)) {
    const start = earliest?.time ?? periodClock(earliest?.period)?.start ?? "00:00";
    const end = latest?.time ?? periodClock(latest?.period)?.end ?? "23:59";
    allowedDateWindows.push({
      ...localInterval(boundaryDate, start, end, input.timeZone),
      label: [earliest?.label, latest?.label].filter(Boolean).join("; "),
      precision: earliest?.time || latest?.time ? "exact" : "named_period",
    });
  } else {
    if (earliest?.time) {
      allowedTimeWindows.push({ start: earliest.time, end: "23:59" });
    }
    if (latest?.time) {
      allowedTimeWindows.push({ start: "00:00", end: latest.time });
    }
  }

  return {
    ...(allowedTimeWindows.length ? { allowedTimeWindows } : {}),
    ...(allowedDateWindows.length
      ? { allowedDateWindows: uniqueTemporalWindows(allowedDateWindows) }
      : {}),
    ...(preferredTimeWindows.length ? { preferredTimeWindows } : {}),
    ...(preferredDateWindows.length
      ? { preferredDateWindows: uniqueTemporalWindows(preferredDateWindows) }
      : {}),
    ...(responsibility.planning?.sessionCount
      ? { sessionCount: responsibility.planning.sessionCount }
      : {}),
    ...(responsibility.planning?.minimumDistinctDays
      ? { minimumDistinctDays: responsibility.planning.minimumDistinctDays }
      : {}),
    ...(responsibility.planning?.maximumSessionMinutes
      ? {
          maximumSessionMinutes: Math.min(
            responsibility.planning.maximumSessionMinutes,
            estimatedMinutes(input, responsibility),
          ),
        }
      : {}),
  };
}

function compileResponsibility(
  input: ExtractionInput,
  responsibility: DraftResponsibility,
  specialTiming = false,
): ExtractedTask {
  const estimate = estimatedMinutes(input, responsibility);
  const category =
    responsibility.planning?.category ?? inferredCategory(responsibility.title);
  const schedulingConstraints = constraintWindows(input, responsibility);
  const sourceSpan = validSourceSpan(input, responsibility);
  const factEvidence = validFactEvidenceSpans(input, responsibility);
  const explicitEvidence = [sourceSpan, ...factEvidence].filter(
    (span): span is SourceEvidenceSpan => Boolean(span),
  );
  const missingInformation = [...responsibility.missingInformation];
  const isMilestone = responsibility.kind === "milestone";
  let inferredFixedEventDuration = false;
  const taskType: ExtractedTask["taskType"] = responsibility.recurrence
    ? "recurring_goal"
    : responsibility.kind === "event"
      ? "fixed_time"
      : "flexible";
  const task: ExtractedTask = {
    id: responsibility.id,
    title: responsibility.title,
    taskType,
    responsibilityKind: responsibility.kind,
    priority: inferredPriority(input, responsibility),
    category,
    energyDemand:
      responsibility.planning?.energyDemand ?? inferredEnergy(category),
    splittable:
      responsibility.planning?.splittable ??
      ((responsibility.planning?.minimumDistinctDays ?? 0) > 1 ||
        (responsibility.kind === "task" && estimate >= 90)),
    estimatedMinutes: isMilestone ? undefined : estimate,
    effortEstimateSource: isMilestone
      ? undefined
      : responsibility.duration?.explicit
        ? "stated"
        : "ai",
    effortEstimateRationale: isMilestone
      ? undefined
      : responsibility.duration?.explicit
        ? "Uses the duration or duration range stated in the source."
        : "Planning-only estimate added after semantic interpretation.",
    minimumSessionMinutes: isMilestone
      ? undefined
      : minimumSessionMinutes(responsibility, estimate),
    confidence: responsibility.confidence,
    fieldConfidence: {
      title: responsibility.confidence,
      taskType: responsibility.confidence,
      ...(isMilestone
        ? {}
        : {
            estimatedMinutes: responsibility.duration?.explicit ? 0.95 : 0.55,
          }),
      priority: responsibility.planning?.priority ? 0.7 : 0.55,
      ...(responsibility.deadline
        ? {
            dueDate: responsibility.deadline.confidence,
            ...(responsibility.deadline.time
              ? { dueTime: responsibility.deadline.confidence }
              : {}),
          }
        : {}),
      ...(responsibility.recurrence
        ? { recurrence: responsibility.confidence }
        : {}),
    },
    missingInformation,
    sourceText: sourceSpan?.quote ?? responsibility.sourceText,
    sourceSpan,
    approved: !responsibility.reviewRequired,
    reviewRequired: responsibility.reviewRequired,
    ...(schedulingConstraints && Object.keys(schedulingConstraints).length
      ? { schedulingConstraints }
      : {}),
    ...(responsibility.duration
      ? {
          durationRange: {
            minimumMinutes:
              responsibility.duration.minimumMinutes ?? estimate,
            ...(responsibility.duration.maximumMinutes
              ? { maximumMinutes: responsibility.duration.maximumMinutes }
              : {}),
            ...(responsibility.duration.preferredMinutes
              ? { preferredMinutes: responsibility.duration.preferredMinutes }
              : {}),
          },
        }
      : {}),
    ...(responsibility.conditionalRules?.length
      ? { conditionalRules: responsibility.conditionalRules }
      : {}),
  };

  if (responsibility.deadline) {
    task.deadlineStrength = responsibility.deadline.strength;
    if (responsibility.deadline.strength === "hard") {
      task.dueDate = responsibility.deadline.date;
      if (responsibility.deadline.time) {
        task.dueTime = responsibility.deadline.time;
        task.dueAt = localInstant(
          responsibility.deadline.date,
          responsibility.deadline.time,
          input.timeZone,
        );
      } else if (responsibility.deadline.period) {
        task.dueWindow = resolvedWindow(
          responsibility.deadline.date,
          responsibility.deadline.period,
          responsibility.deadline.period,
          input.timeZone,
        );
      }
    } else {
      const softWindow = resolvedWindow(
        responsibility.deadline.date,
        responsibility.deadline.period ?? "Preferred completion date",
        responsibility.deadline.period,
        input.timeZone,
        responsibility.deadline.period ? "named_period" : "approximate",
      );
      task.schedulingConstraints = {
        ...task.schedulingConstraints,
        preferredDateWindows: uniqueTemporalWindows([
          ...(task.schedulingConstraints?.preferredDateWindows ?? []),
          softWindow,
        ]),
      };
    }
  }

  if (responsibility.occurrence) {
    const occurrence = responsibility.occurrence;
    if (responsibility.kind !== "event") {
      const existing = task.schedulingConstraints?.allowedDateWindows ?? [];
      const taskDateWindow: TemporalWindow = occurrence.startTime
        ? {
            ...localInterval(
              occurrence.date,
              occurrence.startTime,
              occurrence.endTime ?? "23:59",
              input.timeZone,
            ),
            label: occurrence.period ?? "Explicit task date and time window",
            precision: occurrence.endTime ? "exact" : "approximate",
          }
        : resolvedWindow(
            occurrence.date,
            occurrence.period ?? "Explicit task date",
            occurrence.period,
            input.timeZone,
            occurrence.period ? "named_period" : "approximate",
          );
      task.schedulingConstraints = {
        ...task.schedulingConstraints,
        allowedDateWindows: [...existing, taskDateWindow],
      };
    } else if (occurrence.startTime) {
      task.fixedStartAt = localInstant(
        occurrence.date,
        occurrence.startTime,
        input.timeZone,
      );
      if (occurrence.endTime) {
        task.fixedEndAt = localInterval(
          occurrence.date,
          occurrence.startTime,
          occurrence.endTime,
          input.timeZone,
        ).end;
      } else {
        // The start is an explicit calendar fact; the end is only a planning
        // reservation when its duration was not explicit, so the event can
        // participate in conflict detection. Never present that inference as
        // a stated duration.
        const eventMinutes = responsibility.duration?.explicit
          ? (responsibility.duration.preferredMinutes ??
            responsibility.duration.minimumMinutes ??
            responsibility.duration.maximumMinutes ??
            estimate)
          : estimate;
        task.fixedEndAt = new Date(
          new Date(task.fixedStartAt).getTime() + eventMinutes * 60_000,
        ).toISOString();
        inferredFixedEventDuration = responsibility.duration?.explicit !== true;

        const missingEndOnly =
          task.missingInformation.length > 0 &&
          task.missingInformation.every((detail) =>
            /(?:event\s+)?(?:end(?:\s+time)?|duration|how\s+long).*(?:not\s+(?:specified|stated|provided)|missing|unknown|confirm)|confirm.*(?:end(?:\s+time)?|duration|how\s+long)/i.test(
              detail,
            ),
          );
        if (missingEndOnly) {
          task.missingInformation = [];
          task.reviewRequired = false;
          task.approved = true;
        }
      }
    } else {
      task.occurrenceWindow = resolvedWindow(
        occurrence.date,
        occurrence.period ?? "Unspecified event time",
        occurrence.period,
        input.timeZone,
        occurrence.period ? "named_period" : "approximate",
      );
      const question = "Exact event start and end time are not specified.";
      if (!task.missingInformation.includes(question)) {
        task.missingInformation.push(question);
      }
      task.reviewRequired = true;
      task.approved = false;
    }
  }

  if (responsibility.recurrence) {
    const recurrence = responsibility.recurrence;
    const recurrenceEvidence = responsibilityEvidenceText(input, responsibility);
    const recurrenceIsWindowOnly =
      /\b(?:sometime|any\s*time)\s+(?:between|from)\b/i.test(
        recurrenceEvidence,
      );
    const exactTimes = recurrenceIsWindowOnly
      ? undefined
      : recurrence.exactTimes;
    const activeDays = exactTimes?.length
      ? [...new Set(exactTimes.flatMap((rule) => rule.daysOfWeek))]
      : recurrence.daysOfWeek;
    const startDate =
      recurrence.startDate ??
      (/\b(?:start(?:ing)?|begin(?:ning)?)\s+next\s+week\b/i.test(
        recurrenceEvidence,
      )
        ? format(
            startOfWeek(addWeeks(parseISO(input.currentLocalDate), 1), {
              weekStartsOn: 1,
            }),
            "yyyy-MM-dd",
          )
        : undefined);
    task.recurrence = {
      frequency: recurrence.frequency,
      mode: exactTimes?.length ? "fixed_times" : "quota",
      interval: recurrence.interval ?? 1,
      ...(startDate ? { anchorDate: startDate } : {}),
      ...(recurrence.count
        ? { count: recurrence.count }
        : recurrence.daysOfWeek?.length && !exactTimes?.length
          ? { count: recurrence.daysOfWeek.length }
          : {}),
      ...(activeDays?.length
        ? { daysOfWeek: activeDays }
        : {}),
      ...(exactTimes?.length
        ? { timeRules: exactTimes }
        : {}),
      ...(startDate
        ? { windowStart: localInstant(startDate, "00:00", input.timeZone) }
        : {}),
      ...(recurrence.endDate
        ? {
            windowEnd: localInstant(
              nextDate(recurrence.endDate),
              "00:00",
              input.timeZone,
            ),
          }
        : {}),
    };
    if (recurrence.endCondition && !recurrence.endDate) {
      const detail = `Resolve recurrence end condition: ${recurrence.endCondition}`;
      if (!task.missingInformation.includes(detail)) {
        task.missingInformation.push(detail);
      }
      task.reviewRequired = true;
      task.approved = false;
    }
  }

  const appendProvenance = (
    path: string,
    origin: "explicit" | "derived" | "inferred",
    rationale?: string,
  ) => {
    task.fieldProvenance = [
      ...(task.fieldProvenance ?? []).filter((field) => field.path !== path),
      {
        path,
        origin,
        ...(origin === "inferred" ? {} : { evidence: explicitEvidence }),
        ...(rationale ? { rationale } : {}),
      },
    ];
  };
  if (responsibility.duration?.explicit) {
    appendProvenance("estimatedMinutes", "explicit");
  } else if (inferredFixedEventDuration) {
    appendProvenance(
      "estimatedMinutes",
      "inferred",
      `No end time or duration was stated, so planning reserves a ${estimate}-minute block.`,
    );
  }
  if (responsibility.deadline) {
    appendProvenance("dueDate", "explicit");
    if (task.dueTime) appendProvenance("dueTime", "explicit");
    if (task.dueAt) appendProvenance("dueAt", "derived");
    if (task.dueWindow) appendProvenance("dueWindow", "derived");
  }
  if (responsibility.occurrence) {
    if (task.fixedStartAt) appendProvenance("fixedStartAt", "explicit");
    if (task.fixedEndAt) {
      appendProvenance(
        "fixedEndAt",
        inferredFixedEventDuration ? "inferred" : "derived",
        inferredFixedEventDuration
          ? `No end time or duration was stated, so planning reserves a ${estimate}-minute block after the explicit start.`
          : undefined,
      );
    }
    if (task.occurrenceWindow) appendProvenance("occurrenceWindow", "derived");
  }

  const dateQuote = responsibility.occurrence?.dateSourceText;
  if (!specialTiming && responsibility.kind === "event" && dateQuote !== undefined && (!dateQuote || !input.text.includes(dateQuote))) {
    addReviewQuestion(task, "Confirm the event date. Its displayed date is provisional because no date was quoted from your source.");
    for (const path of ["fixedStartAt", "fixedEndAt", "occurrenceWindow"]) {
      if (task[path as "fixedStartAt" | "fixedEndAt" | "occurrenceWindow"]) appendProvenance(path, "inferred", "Uses a provisional date that needs confirmation.");
    }
  }

  return task;
}

function recoverTaskSpecificTonightRestriction(
  task: ExtractedTask,
  responsibility: DraftResponsibility,
  input: ExtractionInput,
): void {
  if (
    responsibility.kind !== "task" ||
    !/\b(?:do\s+not|don['’]t|cannot|can['’]t)\b[^.!?\r\n]{0,80}\b(?:work|do|start|finish)\b[^.!?\r\n]{0,80}\btonight\b/i.test(
      responsibilityEvidenceText(input, responsibility),
    )
  ) {
    return;
  }

  const nextDay = nextDate(input.currentLocalDate);
  const endDate = task.dueDate ?? nextDay;
  const restriction: TemporalWindow = {
    start: localInstant(nextDay, "00:00", input.timeZone),
    end: localInstant(endDate, task.dueTime ?? "23:59", input.timeZone),
    label: "Do not work on this tonight",
    precision: "exact",
  };
  task.schedulingConstraints = {
    ...task.schedulingConstraints,
    allowedDateWindows: uniqueTemporalWindows([
      ...(task.schedulingConstraints?.allowedDateWindows ?? []).filter(
        (window) => window.start >= restriction.start,
      ),
      restriction,
    ]),
  };
}

function taskBoundaryInstant(
  task: ExtractedTask,
  timeZone: string,
): number | undefined {
  if (task.dueAt) return new Date(task.dueAt).getTime();
  if (task.dueWindow) return new Date(task.dueWindow.start).getTime();
  if (task.dueDate) {
    return new Date(localInstant(task.dueDate, "23:59", timeZone)).getTime();
  }
  if (task.fixedStartAt) return new Date(task.fixedStartAt).getTime();
  if (task.occurrenceWindow) return new Date(task.occurrenceWindow.start).getTime();
  return undefined;
}

function deriveLeadTimeDeadlines(
  tasks: ExtractedTask[],
  timeZone: string,
): void {
  const byId = new Map(tasks.flatMap((task) => (task.id ? [[task.id, task]] : [])));
  tasks.forEach((task) => {
    task.dependencies?.forEach((dependency) => {
      if (
        dependency.relation !== "before" ||
        dependency.strength === "soft" ||
        !dependency.taskId ||
        !dependency.minimumGapMinutes ||
        task.responsibilityKind !== "task"
      ) {
        return;
      }
      const target = byId.get(dependency.taskId);
      if (!target || target.responsibilityKind !== "milestone") return;
      const boundary = taskBoundaryInstant(target, timeZone);
      if (!Number.isFinite(boundary)) return;
      const derived = boundary! - dependency.minimumGapMinutes * 60_000;
      const existing = taskBoundaryInstant(task, timeZone);
      if (Number.isFinite(existing) && existing! <= derived) return;
      const instant = new Date(derived);
      task.deadlineStrength = "hard";
      task.dueDate = formatInTimeZone(instant, timeZone, "yyyy-MM-dd");
      task.dueTime = formatInTimeZone(instant, timeZone, "HH:mm");
      task.dueAt = instant.toISOString();
      task.dueWindow = undefined;
      const rationale = `${dependency.minimumGapMinutes}-minute lead time before ${target.title}, calculated from the cited relationship. AI-interpreted meaning requires confirmation.`;
      task.fieldProvenance = [
        ...(task.fieldProvenance ?? []).filter(
          (field) =>
            field.path !== "dueDate" &&
            field.path !== "dueTime" &&
            field.path !== "dueAt",
        ),
        {
          path: "dueDate",
          origin: "derived",
          evidence: dependency.evidence ? [dependency.evidence] : undefined,
          rationale,
        },
        {
          path: "dueTime",
          origin: "derived",
          evidence: dependency.evidence ? [dependency.evidence] : undefined,
          rationale,
        },
        {
          path: "dueAt",
          origin: "derived",
          evidence: dependency.evidence ? [dependency.evidence] : undefined,
          rationale,
        },
      ];
    });
  });
}

function recoverConfirmedEarlierPreferences(
  tasks: ExtractedTask[],
  input: ExtractionInput,
): void {
  const confirmation =
    /\b(?:yes|correct|that['’]s\s+right)\b[^.!?\r\n]{0,100}\bprefer(?:ably)?\s+earlier\b/gi;
  for (const match of input.text.matchAll(confirmation)) {
    if (match.index === undefined) continue;
    const task = tasks
      .filter(
        (candidate) =>
          candidate.dueDate &&
          candidate.dueTime &&
          candidate.sourceSpan &&
          candidate.sourceSpan.end <= match.index!,
      )
      .sort(
        (left, right) =>
          (right.sourceSpan?.end ?? 0) - (left.sourceSpan?.end ?? 0),
      )[0];
    if (!task?.dueDate || !task.dueTime) continue;
    if (
      task.schedulingConstraints?.preferredDateWindows?.some((window) =>
        /earlier/i.test(window.label),
      )
    ) {
      continue;
    }
    const window: TemporalWindow = {
      ...localInterval(task.dueDate, "00:00", task.dueTime, input.timeZone),
      label: "Preferably earlier",
      precision: "approximate",
    };
    task.schedulingConstraints = {
      ...task.schedulingConstraints,
      preferredDateWindows: [
        ...(task.schedulingConstraints?.preferredDateWindows ?? []),
        window,
      ],
    };
    const evidence: SourceEvidenceSpan = {
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
      start: match.index,
      end: match.index + match[0].length,
      quote: match[0],
    };
    task.fieldProvenance = [
      ...(task.fieldProvenance ?? []).filter(
        (field) =>
          field.path !== "schedulingConstraints.preferredDateWindows",
      ),
      {
        path: "schedulingConstraints.preferredDateWindows",
        origin: "derived",
        evidence: [evidence],
        rationale: "The confirmed deadline was accompanied by a preference to finish earlier.",
      },
    ];
  }
}

function explicitClocks(source: string): Set<string> {
  const clocks = new Set<string>();
  const pattern = /\b(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))\b/gi;
  for (const match of source.matchAll(pattern)) {
    const clock = parseClockTime(match[1].replace(/\./g, ""));
    if (clock) clocks.add(clock);
  }
  if (/\bnoon\b/i.test(source)) clocks.add("12:00");
  if (/\bmidnight\b|\bnight\s+before\b|\bend\s+of\s+(?:the\s+)?day\b/i.test(source)) {
    clocks.add("23:59");
    clocks.add("00:00");
  }
  const sharedMeridiemRange =
    /\b(?:from\s+|between\s+)?(\d{1,2}(?::\d{2})?)\s*(?:-|–|—|to|until|and)\s*(\d{1,2}(?::\d{2})?)\s*(a\.?m\.?|p\.?m\.?)\b/gi;
  for (const match of source.matchAll(sharedMeridiemRange)) {
    const meridiem = match[3].replace(/\./g, "");
    const start = parseClockTime(`${match[1]} ${meridiem}`);
    const end = parseClockTime(`${match[2]} ${meridiem}`);
    if (start) clocks.add(start);
    if (end) clocks.add(end);
  }
  const namedPeriodClock =
    /\b(morning|afternoon|evening|night|tonight)\b[^.!?\r\n]{0,30}\bat\s+(\d{1,2}(?::\d{2})?)\b/gi;
  for (const match of source.matchAll(namedPeriodClock)) {
    const meridiem = /morning/i.test(match[1]) ? "am" : "pm";
    const clock = parseClockTime(`${match[2]} ${meridiem}`);
    if (clock) clocks.add(clock);
  }
  // Only unambiguous 24-hour notation; a bare 3:30 remains AM/PM ambiguous.
  for (const match of source.matchAll(/\b((?:0\d|1[3-9]|2[0-3]):[0-5]\d)\b/g)) clocks.add(match[1]);
  return clocks;
}

function addReviewQuestion(task: ExtractedTask, question: string): void {
  if (!task.missingInformation.includes(question)) {
    task.missingInformation.push(question);
  }
  task.reviewRequired = true;
  task.approved = false;
}

/**
 * Keep source-grounded event anchors as review-only proposals when their clocks
 * are ambiguous. Relative clocks still come from the relationship calculator,
 * and unsupported hard deadline precision is not silently accepted.
 */
function groundCompiledExactTimes(
  tasks: ExtractedTask[],
  input: ExtractionInput,
  sourceById: Map<string, DraftResponsibility>,
  pendingDerivation: Set<string>,
  verifiedLinks: QuotedTiming[],
): void {
  tasks.forEach((task) => {
    const semanticEvidence = task.id
      ? validFactEvidenceSpans(input, sourceById.get(task.id)!).map(
          (span) => span.quote,
        )
      : [];
    const sourceGroundedLabels = [
      task.dueWindow?.label,
      task.occurrenceWindow?.label,
      ...(task.schedulingConstraints?.allowedDateWindows ?? []).map(
        (window) => window.label,
      ),
      ...(task.schedulingConstraints?.preferredDateWindows ?? []).map(
        (window) => window.label,
      ),
    ].filter(
      (label): label is string =>
        Boolean(label) && input.text.toLowerCase().includes(label!.toLowerCase()),
    );
    const sources = [
      ...(input.text.includes(task.sourceText) ? [task.sourceText] : []),
      ...semanticEvidence,
      ...sourceGroundedLabels,
    ];
    const clockSources = pendingDerivation.has(task.id!)
      ? sources.flatMap((source) => clockEvidenceForRelativeTask(source, sourceById.get(task.id!)!, verifiedLinks))
      : sources;
    const clocks = clockSources.reduce((all, source) => {
      explicitClocks(source).forEach((clock) => all.add(clock));
      return all;
    }, new Set<string>());
    if (task.dueTime && !clocks.has(task.dueTime)) {
      task.dueTime = undefined;
      task.dueAt = undefined;
      delete task.fieldConfidence.dueTime;
      task.fieldProvenance = task.fieldProvenance?.filter(
        (field) => field.path !== "dueTime" && field.path !== "dueAt",
      );
      if (!pendingDerivation.has(task.id!)) addReviewQuestion(
        task,
        "Confirm the exact deadline time; no supporting clock appears in the source.",
      );
    }

    if (task.fixedStartAt) {
      const clock = formatInTimeZone(
        new Date(task.fixedStartAt),
        input.timeZone,
        "HH:mm",
      );
      const isProposedAnchor = !clocks.has(clock)
        && sourceById.get(task.id!)?.kind === "event"
        && Boolean(task.sourceSpan?.quote && input.text.includes(task.sourceSpan.quote))
        && !verifiedLinks.some((link) => link.relation.fromId === task.id);
      if (isProposedAnchor) {
        const question = "Confirm the proposed event start time, including AM/PM. The source does not unambiguously specify this clock.";
        addReviewQuestion(task, question);
        task.fieldProvenance = [
          ...(task.fieldProvenance ?? []).filter((field) => field.path !== "fixedStartAt" && field.path !== "fixedEndAt"),
          ...["fixedStartAt", "fixedEndAt"].map((path) => ({
            path,
            origin: "inferred" as const,
            evidence: [task.sourceSpan!],
            rationale: path === "fixedStartAt"
              ? "AI-proposed event anchor retained for confirmation, not a verified source clock."
              : "Proposed end depends on the unconfirmed event start and stated or estimated duration.",
          })),
        ];
      } else if (!clocks.has(clock)) {
        const semanticOccurrence = task.id
          ? sourceById.get(task.id)?.occurrence
          : undefined;
        task.fixedStartAt = undefined;
        task.fixedEndAt = undefined;
        task.fieldProvenance = task.fieldProvenance?.filter(
          (field) =>
            field.path !== "fixedStartAt" && field.path !== "fixedEndAt",
        );
        if (!pendingDerivation.has(task.id!)) addReviewQuestion(
          task,
          "Confirm the event time; no exact clock supporting it appears in the source.",
        );
        if (semanticOccurrence?.date) {
          task.occurrenceWindow = resolvedWindow(
            semanticOccurrence.date,
            semanticOccurrence.period ?? "Event time needs confirmation",
            semanticOccurrence.period,
            input.timeZone,
          );
        }
      }
      // Recompute an unstated end from the duration rather than accepting the
      // model's arithmetic, even when the start itself was correctly stated.
      if (task.fixedStartAt && task.fixedEndAt) {
        const endClock = formatInTimeZone(task.fixedEndAt, input.timeZone, "HH:mm");
        if (!clocks.has(endClock) && sourceById.get(task.id!)?.occurrence?.endTime) {
          task.fixedEndAt = new Date(Date.parse(task.fixedStartAt) + (task.estimatedMinutes ?? 30) * 60_000).toISOString();
          task.fieldProvenance = [
            ...(task.fieldProvenance ?? []).filter((field) => field.path !== "fixedEndAt"),
            { path: "fixedEndAt", origin: !isProposedAnchor && sourceById.get(task.id!)?.duration?.explicit ? "derived" : "inferred", rationale: "Calculated from the event start and its stated or estimated duration." },
          ];
        }
      }
    }
  });
}

/**
 * Compiles the lean, source-grounded AI draft into the persisted scheduler
 * model. This is the deterministic details/normalization/inference boundary:
 * the compiler may normalize and add planning defaults, but never invent a
 * responsibility or semantic relationship.
 */
export function compileSemanticDraft(
  input: ExtractionInput,
  originalDraft: SemanticDraft,
): ExtractionResult {
  const specialIds = specialTimingTaskIds(originalDraft);
  const draft = normalizeSemanticDraft(input, originalDraft, specialIds, false);
  const unverifiedWindows = new Set<string>();
  draft.responsibilities.forEach((item) => {
    if (specialIds.has(item.id)) return;
    const labels = [item.constraints?.earliestStart?.label, item.constraints?.latestEnd?.label, ...(item.constraints?.allowedWindows ?? []).map((window) => window.label), ...(item.constraints?.preferredWindows ?? []).map((window) => window.label)];
    const evidence = [item.sourceText, ...validFactEvidenceSpans(input, item).map((span) => span.quote), ...labels.filter((label): label is string => Boolean(label))].filter((quote) => input.text.includes(quote));
    const clocks = explicitClocks(evidence.join(" "));
    const removeUnsupported = (value: { time?: string; startTime?: string; endTime?: string }) => {
      for (const key of ["time", "startTime", "endTime"] as const) {
        if (value[key] && !clocks.has(value[key]!)) {
          delete value[key];
          unverifiedWindows.add(item.id);
        }
      }
    };
    // Flexible occurrences and constraint windows are also possible hiding
    // places for an AI-derived clock; they need the same evidence boundary.
    if (item.kind !== "event" && item.occurrence) removeUnsupported(item.occurrence);
    if (item.constraints?.earliestStart) removeUnsupported(item.constraints.earliestStart);
    if (item.constraints?.latestEnd) removeUnsupported(item.constraints.latestEnd);
    item.constraints?.allowedWindows?.forEach(removeUnsupported);
    item.constraints?.preferredWindows?.forEach(removeUnsupported);
  });
  const tasks = draft.responsibilities.map((responsibility) =>
    compileResponsibility(input, responsibility, specialIds.has(responsibility.id)),
  );
  const byId = new Map(tasks.flatMap((task) => (task.id ? [[task.id, task]] : [])));
  const sourceById = new Map(
    draft.responsibilities.map((responsibility) => [
      responsibility.id,
      responsibility,
    ]),
  );
  const verifiedLinks: QuotedTiming[] = [];
  draft.relations.forEach((relation) => {
    // Special timing takes the calculator-only branch below. Do not create
    // persistent dependencies or send its interpretation through quote checks.
    if (isSpecialTiming(relation) || specialIds.has(relation.fromId)) return;
    const from = byId.get(relation.fromId);
    const target = byId.get(relation.toId);
    if (!from) return;
    if (!target) {
      requireTimingReview(from, "A timing relationship refers to a missing task; confirm the prerequisite.");
      return;
    }
    const verified = checkQuotedTiming(input, relation, sourceById.get(relation.fromId)!, sourceById.get(relation.toId)!);
    if (!verified) {
      requireTimingReview(from, `Cannot calculate the relationship with ${target.title}: check its exact source quote, task references, and numeric boundaries. Recurring relationships need a specific occurrence.`);
      return;
    }
    const interpretation = `${from.title} (${verified.fromBoundary}) ${verified.mode === "exact" ? "is" : verified.mode === "latest" ? "is no later than" : "is no earlier than"} ${verified.minutes} minutes ${relation.relation} ${target.title} (${verified.toBoundary})${verified.approximate || relation.strength === "soft" ? "; approximate/preferred" : ""}.`;
    requireTimingReview(from, RELATIONSHIP_REVIEW_MESSAGE);
    from.fieldProvenance = [...(from.fieldProvenance ?? []), {
      path: `relationships.${relation.fromId}.${relation.toId}`,
      origin: "inferred",
      evidence: [verified.evidence],
      rationale: interpretation,
    }];
    verifiedLinks.push(verified);
    // The scheduler dependency format is finish-to-start. Other boundary
    // combinations are retained in the interpretation and calculated slots,
    // never silently converted into a different dependency.
    const schedulerCompatible = relation.relation === "before"
      ? (verified.fromBoundary === "end" || verified.arrival) && verified.toBoundary === "start" && verified.mode !== "earliest"
      : verified.fromBoundary === "start" && verified.toBoundary === "end" && verified.mode !== "latest";
    if (!schedulerCompatible) return;
    from.dependencies = [
      ...(from.dependencies ?? []),
      {
        taskId: target.id,
        targetTitle: target.title,
        relation: verified.relation.relation,
        strength: verified.relation.strength,
        minimumGapMinutes: verified.minutes,
        ...(verified.travel ? { maximumLagMinutes: 0 } : relation.maximumLagMinutes === undefined ? {} : { maximumLagMinutes: relation.maximumLagMinutes }),
        evidence: verified.evidence,
      },
    ];
  });
  tasks.forEach((task) => {
    if (specialIds.has(task.id!)) return;
    const responsibility = task.id ? sourceById.get(task.id) : undefined;
    if (responsibility) {
      recoverTaskSpecificTonightRestriction(task, responsibility, input);
    }
  });
  const pendingDerivation = new Set(verifiedLinks.filter((link) => link.mode === "exact").map((link) => link.relation.fromId));
  const mainTasks = tasks.filter((task) => !specialIds.has(task.id!));
  groundCompiledExactTimes(mainTasks, input, sourceById, pendingDerivation, verifiedLinks);
  deriveLeadTimeDeadlines(mainTasks, input.timeZone);
  // The legacy dependency solver only sees ordinary ordering relationships.
  deriveVerifiedTimes(input, mainTasks, draft, verifiedLinks.filter((link) => !specialIds.has(link.relation.toId)));
  recoverConfirmedEarlierPreferences(mainTasks, input);
  tasks.forEach((task) => {
    if (specialIds.has(task.id!)) return;
    if (task.taskType === "fixed_time" && !task.fixedStartAt) {
      task.taskType = "flexible";
      requireTimingReview(task, "Confirm the event time before scheduling; no verified exact start is available.");
    }
    if (pendingDerivation.has(task.id!) && !task.fixedStartAt && !task.dueAt && !task.schedulingConstraints?.preferredDateWindows?.length) {
      requireTimingReview(task, "The relationship has a source quote, but an anchor date/time or work duration is missing; a time cannot yet be calculated.");
    }
    if (unverifiedWindows.has(task.id!) && !task.fieldProvenance?.some((field) => field.origin === "derived" && /calculated from the cited relationship/i.test(field.rationale ?? ""))) {
      requireTimingReview(task, "Confirm the proposed time window; an unsupported exact clock was removed.");
    }
  });

  // Last: no semantic grounding or repair is allowed to erase these outputs.
  calculateAiTiming(input, tasks, draft);

  const globalInstructions = draft.globalInstructions.flatMap((instruction) => {
    const start =
      instruction.sourceStart ?? input.text.indexOf(instruction.sourceText);
    const end = instruction.sourceEnd ?? start + instruction.sourceText.length;
    return start >= 0 && input.text.slice(start, end) === instruction.sourceText
      ? [
          {
            ...(input.sourceId ? { sourceId: input.sourceId } : {}),
            start,
            end,
            quote: instruction.sourceText,
          },
        ]
      : [];
  });
  const blockedTimes = draft.blockedTimes.map((blocked) => ({
    ...localInterval(
      blocked.date,
      blocked.startTime,
      blocked.endTime,
      input.timeZone,
    ),
    label: blocked.label,
  }));

  return {
    tasks,
    ignoredStatements: draft.ignoredStatements,
    ...(blockedTimes.length ? { planningRules: { blockedTimes } } : {}),
    interpretation: {
      discoveredResponsibilityCount: tasks.length,
      explicitFieldCount: 0,
      derivedFieldCount: 0,
      inferredFieldCount: 0,
      globalInstructions,
      validationWarnings: [],
    },
  };
}
