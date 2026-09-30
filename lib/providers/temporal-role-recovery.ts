import { fromZonedTime } from "date-fns-tz";

import {
  resolveRelativeDate,
} from "@/lib/domain/date-interpretation";
import { validateAndDedupeExtraction } from "@/lib/domain/extraction-schema";
import type {
  ExtractedTask,
  ExtractionInput,
  ExtractionResult,
  FieldOrigin,
  FieldProvenance,
  SourceEvidenceSpan,
  TemporalWindow,
} from "@/lib/domain/types";

type SourceSentence = SourceEvidenceSpan & { text: string };

type TemporalDirective =
  | {
      role: "due";
      sentence: SourceSentence;
      dueDate: string;
      dueTime?: string;
      dueAt?: string;
      dueWindow?: TemporalWindow;
    }
  | {
      role: "fixed";
      sentence: SourceSentence;
      fixedStartAt: string;
      durationMinutes?: number;
    }
  | {
      role: "preference";
      sentence: SourceSentence;
      preferredWindow: TemporalWindow;
    };

const WEEKDAY =
  "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)";
const MONTH =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const CLOCK = "(?:\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?))";
const CALENDAR_DATE = `${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?`;
const RELATIVE_DATE = `(?:(?:this|next)\\s+)?${WEEKDAY}|today|tomorrow`;
const DATE_EXPRESSION = `(?:${WEEKDAY}\\s*,\\s*)?${CALENDAR_DATE}|${RELATIVE_DATE}`;
const DAYPART = "morning|afternoon|evening|night";

const TEMPORAL_MISSING =
  /(?:due|deadline|date|time|when|fixed|event start|event end|end time|duration|effort estimate)/i;

const TOKEN_STOP_WORDS = new Set([
  "a",
  "about",
  "afternoon",
  "an",
  "and",
  "at",
  "before",
  "by",
  "due",
  "evening",
  "for",
  "friday",
  "i",
  "if",
  "in",
  "is",
  "it",
  "monday",
  "morning",
  "night",
  "of",
  "on",
  "please",
  "reminder",
  "saturday",
  "so",
  "sunday",
  "that",
  "the",
  "then",
  "this",
  "thursday",
  "to",
  "try",
  "tuesday",
  "wednesday",
  "we",
  "will",
  "with",
  "you",
]);

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
};

function sentences(input: ExtractionInput): SourceSentence[] {
  const values: SourceSentence[] = [];
  const pattern = /[^.!?\r\n]+(?:[.!?]+(?=\s|$)|$)/gu;
  for (const match of input.text.matchAll(pattern)) {
    const raw = match[0];
    const leading = raw.search(/\S/u);
    if (leading < 0) continue;
    const text = raw.trimEnd();
    const start = match.index + leading;
    const quote = text.slice(leading);
    if (!quote) continue;
    values.push({
      sourceId: input.sourceId,
      start,
      end: start + quote.length,
      quote,
      text: quote,
    });
  }
  return values;
}

function normalizeClockSpelling(value: string): string {
  return value.replace(/([ap])\.m\./gi, "$1m");
}

function normalizedDateExpression(value: string): string {
  return normalizeClockSpelling(value)
    .trim()
    .replace(/[.,;:]+$/u, "")
    .replace(new RegExp(`^${WEEKDAY}\\s*,\\s*(?=${MONTH}\\b)`, "i"), "");
}

function resolveExpression(
  expression: string,
  input: ExtractionInput,
): ReturnType<typeof resolveRelativeDate> {
  return resolveRelativeDate(
    normalizedDateExpression(expression),
    input.currentLocalDate,
    input.timeZone,
  );
}

function exactDateTime(text: string): string | undefined {
  const match = new RegExp(
    `\\b((?:${DATE_EXPRESSION})\\s+at\\s+${CLOCK})\\b`,
    "i",
  ).exec(text);
  return match?.[1];
}

function namedDaypart(
  text: string,
): { expression: string; daypart: string } | undefined {
  const match = new RegExp(
    `\\b((?:${DATE_EXPRESSION})\\s+(${DAYPART}))\\b`,
    "i",
  ).exec(text);
  return match ? { expression: match[1], daypart: match[2] } : undefined;
}

function dateOnly(text: string): string | undefined {
  const match = new RegExp(`\\b(${DATE_EXPRESSION})\\b`, "i").exec(text);
  return match?.[1];
}

function namedPeriodTimes(daypart: string): { start: string; end: string } {
  switch (daypart.toLocaleLowerCase()) {
    case "morning":
      return { start: "09:00", end: "12:00" };
    case "afternoon":
      return { start: "12:00", end: "17:00" };
    case "evening":
      return { start: "17:00", end: "21:00" };
    default:
      return { start: "21:00", end: "23:59" };
  }
}

function namedPeriodWindow(
  expression: string,
  daypart: string,
  input: ExtractionInput,
): { date: string; window: TemporalWindow } | undefined {
  const dateExpression = expression.replace(
    new RegExp(`\\s+(?:${DAYPART})$`, "i"),
    "",
  );
  const resolved = resolveExpression(dateExpression, input);
  if (!resolved.date || resolved.ambiguous) return undefined;
  const times = namedPeriodTimes(daypart);
  return {
    date: resolved.date,
    window: {
      start: fromZonedTime(
        `${resolved.date}T${times.start}:00`,
        input.timeZone,
      ).toISOString(),
      end: fromZonedTime(
        `${resolved.date}T${times.end}:00`,
        input.timeZone,
      ).toISOString(),
      label: expression.trim(),
      precision: "named_period",
    },
  };
}

function durationMinutes(text: string): number | undefined {
  const halfHour =
    /\b(?:for\s+)?(?:(?:about|around|approximately|roughly)\s+)?(?:a\s+)?half(?:\s+an?)?\s+hour\b/i;
  if (halfHour.test(text)) return 30;

  const articleHour =
    /\b(?:for\s+)?(?:(?:about|around|approximately|roughly)\s+)?an?\s+hour\b/i;
  if (articleHour.test(text)) return 60;

  const value =
    /\b(?:for\s+)?(?:(?:about|around|approximately|roughly)\s+)?(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight)\s*(hours?|hrs?|minutes?|mins?)\b/i.exec(
      text,
    );
  if (!value) return undefined;
  const amount = NUMBER_WORDS[value[1].toLocaleLowerCase()] ?? Number(value[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  return /^(?:hours?|hrs?)$/i.test(value[2])
    ? Math.round(amount * 60)
    : Math.round(amount);
}

function isFixedOccurrence(text: string): boolean {
  if (/\bmeet\s+(?:the|a|this)\s+deadline\b/i.test(text)) return false;
  if (
    /\b(?:schedule|cancel|reschedule|arrange|move)\b[^.!?\n]{0,32}\b(?:a\s+|the\s+)?(?:meeting|appointment|call|interview)\b/i.test(
      text,
    )
  ) {
    return false;
  }
  return Boolean(
    /\b(?:we|i|you|they)\s*(?:['’]ll|will)?\s*meet\b/i.test(text) ||
      /\bmeet\s+with\b/i.test(text) ||
      /^\s*meet\b/i.test(text) ||
      /\b(?:we|i|you|they)\s+(?:have|have got|are having)\s+(?:a|an|the)\s+(?:meeting|appointment|call|interview)\b/i.test(
        text,
      ) ||
      /\b(?:meeting|appointment|interview|class|exam|quiz)\s+(?:is\s+)?(?:on\s+)?(?:this\s+|next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(
        text,
      )
  );
}

function softPreferenceSegment(text: string): string | undefined {
  if (
    !/\b(?:if\s+possible|ideally|prefer(?:ably)?|try\s+to|would\s+like\s+to)\b/i.test(
      text,
    )
  ) {
    return undefined;
  }
  // Dates after a reason marker explain why the preference exists; they are
  // not a second scheduling instruction ("Thursday evening so ... Friday night").
  return text.split(
    /\b(?:so(?:\s+that)?|because|rather\s+than|instead\s+of|to\s+avoid|without)\b/i,
    1,
  )[0];
}

function dueTail(text: string): string | undefined {
  const marker =
    /\b(?:due(?:\s+(?:on|by))?|deadline(?:\s+(?:is|on|of))?|by)\b/i.exec(
      text,
    );
  return marker ? text.slice(marker.index + marker[0].length) : undefined;
}

function directiveForSentence(
  sentence: SourceSentence,
  input: ExtractionInput,
): TemporalDirective | undefined {
  const text = sentence.text;
  const fixedExpression = isFixedOccurrence(text)
    ? exactDateTime(text)
    : undefined;
  if (fixedExpression) {
    const resolved = resolveExpression(fixedExpression, input);
    if (resolved.instant && !resolved.ambiguous) {
      return {
        role: "fixed",
        sentence,
        fixedStartAt: resolved.instant,
        durationMinutes: durationMinutes(text),
      };
    }
  }

  const preferenceText = softPreferenceSegment(text);
  const preference = preferenceText
    ? namedDaypart(preferenceText)
    : undefined;
  if (preference) {
    const resolved = namedPeriodWindow(
      preference.expression,
      preference.daypart,
      input,
    );
    if (resolved) {
      return {
        role: "preference",
        sentence,
        preferredWindow: resolved.window,
      };
    }
  }

  const tail = dueTail(text);
  if (!tail) return undefined;
  const exactExpression = exactDateTime(tail);
  if (exactExpression) {
    const resolved = resolveExpression(exactExpression, input);
    if (resolved.date && resolved.time && resolved.instant && !resolved.ambiguous) {
      return {
        role: "due",
        sentence,
        dueDate: resolved.date,
        dueTime: resolved.time,
        dueAt: resolved.instant,
      };
    }
  }

  const period = namedDaypart(tail);
  if (period) {
    const resolved = namedPeriodWindow(period.expression, period.daypart, input);
    if (resolved) {
      return {
        role: "due",
        sentence,
        dueDate: resolved.date,
        dueWindow: resolved.window,
      };
    }
  }

  const dateExpression = dateOnly(tail);
  if (!dateExpression) return undefined;
  const resolved = resolveExpression(dateExpression, input);
  return resolved.date && !resolved.ambiguous
    ? { role: "due", sentence, dueDate: resolved.date }
    : undefined;
}

function normalized(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLocaleLowerCase();
}

function tokens(value: string): Set<string> {
  return new Set(
    normalized(value)
      .split(/\s+/u)
      .filter((token) => token.length >= 3 && !TOKEN_STOP_WORDS.has(token)),
  );
}

function overlap(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  left.forEach((token) => {
    if (right.has(token)) shared += 1;
  });
  return shared / Math.min(left.size, right.size);
}

function spansOverlap(task: ExtractedTask, sentence: SourceSentence): boolean {
  return Boolean(
    task.sourceSpan &&
      task.sourceSpan.start < sentence.end &&
      task.sourceSpan.end > sentence.start,
  );
}

function matchScore(task: ExtractedTask, directive: TemporalDirective): number {
  const sentence = directive.sentence;
  const source = normalized(task.sourceText);
  const sentenceText = normalized(sentence.text);
  const titleOverlap = overlap(tokens(task.title), tokens(sentence.text));
  const sourceOverlap = overlap(tokens(task.sourceText), tokens(sentence.text));
  const exactSource =
    source.length >= 8 &&
    (source === sentenceText ||
      (source.length < sentenceText.length && sentenceText.includes(source)));
  return (
    (spansOverlap(task, sentence) ? 20 : 0) +
    (exactSource ? 10 : 0) +
    titleOverlap * 6 +
    sourceOverlap * 2
  );
}

function matchingDirective(
  task: ExtractedTask,
  directives: TemporalDirective[],
): TemporalDirective | undefined {
  let best: { directive: TemporalDirective; score: number } | undefined;
  directives.forEach((directive) => {
    const score = matchScore(task, directive);
    if (!best || score > best.score) best = { directive, score };
  });
  return best && best.score >= 2 ? best.directive : undefined;
}

function withProvenance(
  task: ExtractedTask,
  sentence: SourceSentence,
  entries: Array<{
    path: string;
    origin: FieldOrigin;
    rationale?: string;
  }>,
): FieldProvenance[] {
  const byPath = new Map(
    (task.fieldProvenance ?? []).map((entry) => [entry.path, entry]),
  );
  entries.forEach((entry) => {
    byPath.set(entry.path, {
      ...entry,
      evidence: [
        {
          sourceId: sentence.sourceId,
          start: sentence.start,
          end: sentence.end,
          quote: sentence.quote,
        },
      ],
    });
  });
  return [...byPath.values()];
}

function withoutPreferredDateWindows(
  constraints: ExtractedTask["schedulingConstraints"],
): ExtractedTask["schedulingConstraints"] {
  if (!constraints) return undefined;
  const remaining = { ...constraints };
  delete remaining.preferredDateWindows;
  return Object.keys(remaining).length ? remaining : undefined;
}

function cleanMissing(task: ExtractedTask): string[] {
  return task.missingInformation.filter((item) => !TEMPORAL_MISSING.test(item));
}

function completionState(
  task: ExtractedTask,
  missingInformation: string[],
): Pick<ExtractedTask, "approved" | "reviewRequired"> {
  if (task.completed || task.cancelled) {
    return {
      approved: task.approved,
      reviewRequired: task.reviewRequired,
    };
  }
  return {
    approved: missingInformation.length === 0,
    reviewRequired: missingInformation.length > 0,
  };
}

function applyDirective(
  task: ExtractedTask,
  directive: TemporalDirective,
): ExtractedTask {
  const sentence = directive.sentence;
  if (directive.role === "due") {
    const missingInformation = cleanMissing(task);
    return {
      ...task,
      taskType: "flexible",
      dueDate: directive.dueDate,
      dueTime: directive.dueTime,
      dueAt: directive.dueAt,
      dueWindow: directive.dueWindow,
      fixedStartAt: undefined,
      fixedEndAt: undefined,
      recurrence: undefined,
      schedulingConstraints: withoutPreferredDateWindows(
        task.schedulingConstraints,
      ),
      fieldConfidence: {
        ...task.fieldConfidence,
        taskType: 0.99,
        dueDate: 0.99,
        dueTime: directive.dueTime ? 0.99 : undefined,
      },
      fieldProvenance: withProvenance(task, sentence, [
        {
          path: "taskType",
          origin: "derived",
          rationale: "Deadline language describes completion by a time, not an occurrence at that time.",
        },
        { path: "dueDate", origin: "explicit" },
        ...(directive.dueTime
          ? [{ path: "dueTime", origin: "explicit" as const }]
          : []),
        ...(directive.dueAt
          ? [
              {
                path: "dueAt",
                origin: "derived" as const,
                rationale: "Converted the explicit local deadline to an instant in the workspace time zone.",
              },
            ]
          : []),
        ...(directive.dueWindow
          ? [
              {
                path: "dueWindow",
                origin: "derived" as const,
                rationale: "Preserved the named daypart as a bounded local-time window without inventing an exact due time.",
              },
            ]
          : []),
      ]),
      missingInformation,
      ...completionState(task, missingInformation),
    };
  }

  if (directive.role === "fixed") {
    const duration = directive.durationMinutes;
    const missingInformation = cleanMissing(task);
    if (!duration) missingInformation.push("Confirm the event duration");
    const fixedEndAt = duration
      ? new Date(
          new Date(directive.fixedStartAt).getTime() + duration * 60_000,
        ).toISOString()
      : undefined;
    return {
      ...task,
      taskType: "fixed_time",
      dueDate: undefined,
      dueTime: undefined,
      dueAt: undefined,
      dueWindow: undefined,
      fixedStartAt: directive.fixedStartAt,
      fixedEndAt,
      recurrence: undefined,
      estimatedMinutes: duration ?? task.estimatedMinutes,
      effortEstimateSource: duration ? "stated" : task.effortEstimateSource,
      effortEstimateRationale: duration
        ? "Used the event duration stated in the source."
        : task.effortEstimateRationale,
      splittable: false,
      minimumSessionMinutes: duration ?? task.minimumSessionMinutes,
      schedulingConstraints: withoutPreferredDateWindows(
        task.schedulingConstraints,
      ),
      fieldConfidence: {
        ...task.fieldConfidence,
        taskType: 0.99,
        estimatedMinutes: duration ? 0.99 : task.fieldConfidence.estimatedMinutes,
      },
      fieldProvenance: withProvenance(task, sentence, [
        {
          path: "taskType",
          origin: "derived",
          rationale: "Occurrence language plus an exact date and time identifies a fixed event.",
        },
        { path: "fixedStartAt", origin: "explicit" },
        ...(fixedEndAt
          ? [
              {
                path: "fixedEndAt",
                origin: "derived" as const,
                rationale: "Derived from the explicit start and stated duration.",
              },
            ]
          : []),
        ...(duration
          ? [{ path: "estimatedMinutes", origin: "explicit" as const }]
          : []),
      ]),
      missingInformation,
      ...completionState(task, missingInformation),
    };
  }

  const missingInformation = cleanMissing(task);
  const schedulingConstraints = {
    ...task.schedulingConstraints,
    preferredDateWindows: [directive.preferredWindow],
  };
  return {
    ...task,
    taskType: "flexible",
    dueDate: undefined,
    dueTime: undefined,
    dueAt: undefined,
    dueWindow: undefined,
    fixedStartAt: undefined,
    fixedEndAt: undefined,
    recurrence: undefined,
    schedulingConstraints,
    fieldConfidence: {
      ...task.fieldConfidence,
      taskType: 0.99,
    },
    fieldProvenance: withProvenance(task, sentence, [
      {
        path: "taskType",
        origin: "derived",
        rationale: "Soft preference wording describes when to schedule work, not a deadline or fixed event.",
      },
      {
        path: "schedulingConstraints.preferredDateWindows",
        origin: "derived",
        rationale: "Resolved the stated date and named daypart without treating the preference as a deadline.",
      },
    ]),
    missingInformation,
    ...completionState(task, missingInformation),
  };
}

/**
 * Reconciles temporal roles from the original wording after any extraction
 * provider runs. Explicit deadline, occurrence, and soft-preference language
 * wins over provider guesses; the function only repairs existing tasks.
 */
export function recoverTemporalRoles(
  input: ExtractionInput,
  result: ExtractionResult,
): ExtractionResult {
  if (!result.tasks.length) return result;
  const directives = sentences(input)
    .map((sentence) => directiveForSentence(sentence, input))
    .filter((directive): directive is TemporalDirective => Boolean(directive));
  if (!directives.length) return result;

  return validateAndDedupeExtraction({
    ...result,
    tasks: result.tasks.map((task) => {
      const directive = matchingDirective(task, directives);
      return directive ? applyDirective(task, directive) : task;
    }),
  });
}
