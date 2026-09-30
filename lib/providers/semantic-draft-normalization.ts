import {
  addDays,
  addWeeks,
  differenceInCalendarDays,
  format,
  isValid,
  parseISO,
  startOfWeek,
} from "date-fns";

import {
  parseClockTime,
  resolveRelativeDate,
} from "@/lib/domain/date-interpretation";
import type { ExtractionInput } from "@/lib/domain/types";
import type { SemanticDraft } from "./semantic-draft";

type Responsibility = SemanticDraft["responsibilities"][number];

const WEEKDAY_OFFSETS: Record<string, number> = {
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
  sunday: 6,
};

const HARD_DEADLINE_WORDING =
  /\b(?:due|deadline|must\s+be|needs?\s+to\s+be|(?:done|ready|finished|sent|submitted)\s+by|by\s+(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d))\b/i;
const ANAPHORIC_CONTINUATION =
  /^\s*(?:it|it['’]s|its|this|that|these|those)\b/i;
function sourceRange(
  input: ExtractionInput,
  responsibility: Responsibility,
): { start: number; end: number } | undefined {
  if (
    responsibility.sourceStart !== undefined &&
    responsibility.sourceEnd !== undefined &&
    responsibility.sourceStart >= 0 &&
    responsibility.sourceEnd > responsibility.sourceStart &&
    responsibility.sourceEnd <= input.text.length &&
    input.text.slice(responsibility.sourceStart, responsibility.sourceEnd) ===
      responsibility.sourceText
  ) {
    return {
      start: responsibility.sourceStart,
      end: responsibility.sourceEnd,
    };
  }
  const start = input.text.indexOf(responsibility.sourceText);
  return start < 0
    ? undefined
    : { start, end: start + responsibility.sourceText.length };
}

function paragraphAt(text: string, index: number): { start: number; end: number } {
  const before = text.slice(0, index);
  const boundary = Math.max(before.lastIndexOf("\n\n"), before.lastIndexOf("\r\n\r\n"));
  const start = boundary < 0 ? 0 : boundary + (before.slice(boundary).startsWith("\r\n\r\n") ? 4 : 2);
  const after = text.slice(index);
  const nextLf = after.indexOf("\n\n");
  const nextCrLf = after.indexOf("\r\n\r\n");
  const distances = [nextLf, nextCrLf].filter((value) => value >= 0);
  const end = distances.length ? index + Math.min(...distances) : text.length;
  return { start, end };
}

function nextWeekday(currentLocalDate: string, weekday: string): string {
  const nextMonday = startOfWeek(addWeeks(parseISO(currentLocalDate), 1), {
    weekStartsOn: 1,
  });
  return format(addDays(nextMonday, WEEKDAY_OFFSETS[weekday]), "yyyy-MM-dd");
}

function bareWeekdays(text: string): Set<string> {
  const weekdays = new Set<string>();
  const pattern = new RegExp(
    `\\b(?:(next|this)\\s+)?(${Object.keys(WEEKDAY_OFFSETS).join("|")})\\b`,
    "gi",
  );
  for (const match of text.matchAll(pattern)) {
    if (!match[1]) weekdays.add(match[2].toLowerCase());
  }
  return weekdays;
}

function weekdayOfDate(date: string): string | undefined {
  const parsed = parseISO(date);
  return isValid(parsed) ? format(parsed, "eeee").toLowerCase() : undefined;
}

/**
 * Retarget only the temporal fact that is grounded by this weekday. A single
 * responsibility can contain independent facts (for example, an early-next-
 * week work preference and a Thursday deadline), so applying one weekday to
 * every dated field corrupts otherwise-correct windows.
 */
function setScopedDates(
  responsibility: Responsibility,
  scopedWeekdays: Set<string>,
  currentLocalDate: string,
): void {
  const retargetPrimaryFact = (
    fact: { date: string; period?: string } | undefined,
  ) => {
    if (!fact) return;
    const periodWeekdays = fact.period ? bareWeekdays(fact.period) : new Set<string>();
    const weekday =
      [...periodWeekdays].find((candidate) => scopedWeekdays.has(candidate)) ??
      weekdayOfDate(fact.date);
    if (weekday && scopedWeekdays.has(weekday)) {
      fact.date = nextWeekday(currentLocalDate, weekday);
    }
  };

  retargetPrimaryFact(responsibility.deadline);
  retargetPrimaryFact(responsibility.occurrence);

  const retargetWindow = (
    window: { date?: string; period?: string; label: string },
  ) => {
    if (!window.date) return;
    // Windows need their own weekday evidence. Their date alone is not enough:
    // it may encode a different phrase such as "early next week".
    const ownWeekdays = bareWeekdays(
      [window.period, window.label].filter(Boolean).join(" "),
    );
    const weekday = [...ownWeekdays].find((candidate) =>
      scopedWeekdays.has(candidate),
    );
    if (weekday) window.date = nextWeekday(currentLocalDate, weekday);
  };

  responsibility.constraints?.allowedWindows?.forEach(retargetWindow);
  responsibility.constraints?.preferredWindows?.forEach(retargetWindow);
}

function latestResponsibilityDate(
  responsibility: Responsibility,
): string | undefined {
  const dates = [
    responsibility.deadline?.date,
    responsibility.occurrence?.date,
    responsibility.constraints?.earliestStart?.date,
    responsibility.constraints?.latestEnd?.date,
    ...(responsibility.constraints?.allowedWindows ?? []).map(
      (window) => window.date,
    ),
    ...(responsibility.constraints?.preferredWindows ?? []).map(
      (window) => window.date,
    ),
  ].filter((date): date is string => Boolean(date));
  return dates.sort().at(-1);
}

function setAllResponsibilityDates(
  responsibility: Responsibility,
  date: string,
): void {
  if (responsibility.deadline) responsibility.deadline.date = date;
  if (responsibility.occurrence) responsibility.occurrence.date = date;
  responsibility.constraints?.allowedWindows?.forEach((window) => {
    if (window.date) window.date = date;
  });
  responsibility.constraints?.preferredWindows?.forEach((window) => {
    if (window.date) window.date = date;
  });
  if (responsibility.constraints?.earliestStart?.date) {
    responsibility.constraints.earliestStart.date = date;
  }
  if (responsibility.constraints?.latestEnd?.date) {
    responsibility.constraints.latestEnd.date = date;
  }
}

/** Resolve a bare weekday after "this weekend" into the following week. */
function normalizePostWeekendWeekdays(
  input: ExtractionInput,
  responsibilities: Responsibility[],
): void {
  const ordered = responsibilities
    .map((responsibility) => ({
      responsibility,
      range: sourceRange(input, responsibility),
    }))
    .sort(
      (left, right) =>
        (left.range?.start ?? Number.MAX_SAFE_INTEGER) -
        (right.range?.start ?? Number.MAX_SAFE_INTEGER),
    );

  ordered.forEach((entry, index) => {
    if (!entry.range) return;
    const weekdays = [...bareWeekdays(entry.responsibility.sourceText)];
    if (weekdays.length !== 1) return;
    const previous = ordered[index - 1];
    if (
      !previous?.range ||
      entry.range.start - previous.range.end > 160
    ) {
      return;
    }
    const priorEvidence = [
      previous.responsibility.sourceText,
      ...(previous.responsibility.factEvidence ?? []).map(
        (evidence) => evidence.sourceText,
      ),
    ].join(" ");
    if (!/\bthis\s+weekend\b/i.test(priorEvidence)) return;
    const weekendDates = [
      ...(previous.responsibility.deadline &&
      /weekend/i.test(previous.responsibility.deadline.period ?? "")
        ? [previous.responsibility.deadline.date]
        : []),
      ...(previous.responsibility.constraints?.allowedWindows ?? []).flatMap(
        (window) =>
          window.date && /weekend/i.test(`${window.period ?? ""} ${window.label}`)
            ? [window.date]
            : [],
      ),
      ...(previous.responsibility.constraints?.preferredWindows ?? []).flatMap(
        (window) =>
          window.date && /weekend/i.test(`${window.period ?? ""} ${window.label}`)
            ? [window.date]
            : [],
      ),
    ].sort();
    const priorDate =
      weekendDates.at(-1) ?? latestResponsibilityDate(previous.responsibility);
    if (!priorDate) return;
    const existingDate = latestResponsibilityDate(entry.responsibility);
    if (existingDate && existingDate > priorDate) return;
    const followingMonday = startOfWeek(addWeeks(parseISO(priorDate), 1), {
      weekStartsOn: 1,
    });
    setAllResponsibilityDates(
      entry.responsibility,
      format(
        addDays(followingMonday, WEEKDAY_OFFSETS[weekdays[0]]),
        "yyyy-MM-dd",
      ),
    );
  });
}

function normalizeUnscopedBareWeekdays(
  input: ExtractionInput,
  responsibilities: Responsibility[],
): void {
  responsibilities.forEach((responsibility) => {
    const weekdays = [...bareWeekdays(responsibility.sourceText)];
    if (weekdays.length !== 1) return;
    if (
      /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{1,2}[/-]\d{1,2})\b/i.test(
        responsibility.sourceText,
      )
    ) {
      return;
    }
    const range = sourceRange(input, responsibility);
    if (!range) return;
    const paragraph = paragraphAt(input.text, range.start);
    const context = input.text.slice(paragraph.start, paragraph.end);
    if (
      /\b(?:next\s+week|this\s+weekend|following\s+week|week\s+after\s+next|in\s+\d+\s+weeks?)\b/i.test(
        context,
      )
    ) {
      return;
    }
    const resolved = resolveRelativeDate(
      weekdays[0],
      input.currentLocalDate,
      input.timeZone,
    );
    const existingDate = latestResponsibilityDate(responsibility);
    const existingDistance = existingDate
      ? differenceInCalendarDays(
          parseISO(existingDate),
          parseISO(input.currentLocalDate),
        )
      : undefined;
    if (
      resolved.date &&
      !resolved.ambiguous &&
      (existingDistance === undefined ||
        existingDistance < 0 ||
        existingDistance > 8)
    ) {
      setAllResponsibilityDates(responsibility, resolved.date);
    }
  });
}

function normalizeExplicitRelativeWeekdays(
  input: ExtractionInput,
  responsibilities: Responsibility[],
): void {
  responsibilities.forEach((responsibility) => {
    if (responsibility.recurrence) return;
    const matches = [
      ...responsibility.sourceText.matchAll(
        /\b(next|this)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
      ),
    ];
    if (matches.length !== 1) return;
    const modifier = matches[0][1].toLowerCase();
    const weekday = matches[0][2].toLowerCase();
    const resolved =
      modifier === "next"
        ? { date: nextWeekday(input.currentLocalDate, weekday), ambiguous: false }
        : resolveRelativeDate(
            `${modifier} ${weekday}`,
            input.currentLocalDate,
            input.timeZone,
          );
    if (resolved.date && !resolved.ambiguous) {
      setAllResponsibilityDates(responsibility, resolved.date);
    }
  });
}

const DURATION_NUMBER: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  twelve: 12,
};

function durationNumber(value: string): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : DURATION_NUMBER[value.toLowerCase()];
}

function recoverExplicitSingleDurations(
  input: ExtractionInput,
  responsibilities: Responsibility[],
): void {
  const sentencePattern = /[^.!?\r\n]+[.!?]?/g;
  const durationPattern =
    /\b(?:takes?|should\s+take|might\s+take|for|want|need)\s+(?:me\s+)?(?:about\s+|around\s+|roughly\s+|approximately\s+|at\s+least\s+)?(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s*(minutes?|mins?|hours?|hrs?)\b/i;
  for (const match of input.text.matchAll(sentencePattern)) {
    if (match.index === undefined) continue;
    const sourceText = match[0].trim();
    const duration = durationPattern.exec(sourceText);
    if (!duration) continue;
    // This recovery grammar handles a single quantity. Leave compound amounts
    // intact for the full duration checker instead of rewriting 1.5 hours to 1.
    if (/^\s+and\s+(?:a\s+)?(?:half|quarter|\d|one|two|three|four|five|six|seven|eight|nine|ten)/i.test(sourceText.slice(duration.index + duration[0].length))) continue;
    const amount = durationNumber(duration[1]);
    if (!amount) continue;
    const minutes = Math.round(
      amount * (/^(?:hours?|hrs?)$/i.test(duration[2]) ? 60 : 1),
    );
    const normalizedSentence = sourceText.toLowerCase();
    const ranked = responsibilities
      .map((responsibility) => ({
        responsibility,
        score: meaningfulTitleWords(responsibility.title).filter((word) =>
          normalizedSentence.includes(word),
        ).length,
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score);
    if (!ranked.length || ranked[1]?.score === ranked[0].score) continue;
    const responsibility = ranked[0].responsibility;
    if (!responsibility.sourceText.includes(duration[0]) &&
      !responsibility.factEvidence?.some((span) => span.sourceText.includes(duration[0]))) continue;
    // Do not overwrite an explicit AI duration using a different quantity in
    // the same sentence. This recovery is only for a missing work estimate.
    if (responsibility.duration?.explicit &&
      (responsibility.duration.preferredMinutes ?? responsibility.duration.minimumMinutes ?? responsibility.duration.maximumMinutes) !== undefined) continue;
    responsibility.duration = {
      minimumMinutes: minutes,
      preferredMinutes: minutes,
      maximumMinutes: minutes,
      explicit: true,
      approximate: responsibility.duration?.approximate ?? /\b(?:about|around|roughly|approximately|might)\b/i.test(duration[0]),
    };
    responsibility.planning = {
      ...responsibility.planning,
      estimatedMinutes: minutes,
    };
    const leadingWhitespace = match[0].match(/^\s*/)?.[0].length ?? 0;
    addFactEvidence(
      responsibility,
      sourceText,
      match.index + leadingWhitespace,
    );
  }
}

function addFactEvidence(
  responsibility: Responsibility,
  sourceText: string,
  sourceStart: number,
): void {
  const sourceEnd = sourceStart + sourceText.length;
  if (
    responsibility.factEvidence?.some(
      (evidence) =>
        evidence.sourceStart === sourceStart && evidence.sourceEnd === sourceEnd,
    )
  ) {
    return;
  }
  responsibility.factEvidence = [
    ...(responsibility.factEvidence ?? []),
    { sourceText, sourceStart, sourceEnd },
  ];
}

function meaningfulTitleWords(title: string): string[] {
  const ignored = new Set([
    "finish",
    "complete",
    "start",
    "work",
    "prepare",
    "study",
    "send",
    "make",
    "task",
  ]);
  return title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !ignored.has(word));
}

/** Recover only explicit numeric ranges that map to one discovered identity. */
function recoverExplicitDurationRanges(
  input: ExtractionInput,
  responsibilities: Responsibility[],
): void {
  const pattern =
    /\b(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s*(hours?|hrs?|minutes?|mins?)\b/gi;
  for (const match of input.text.matchAll(pattern)) {
    if (match.index === undefined) continue;
    const before = input.text.slice(0, match.index);
    const sentenceStart =
      Math.max(
        before.lastIndexOf("."),
        before.lastIndexOf("!"),
        before.lastIndexOf("?"),
        before.lastIndexOf("\n"),
      ) + 1;
    const afterStart = match.index + match[0].length;
    const after = input.text.slice(afterStart);
    const nextBoundaries = [
      after.indexOf("."),
      after.indexOf("!"),
      after.indexOf("?"),
      after.indexOf("\n"),
    ].filter((index) => index >= 0);
    const sentenceEnd =
      nextBoundaries.length > 0
        ? afterStart + Math.min(...nextBoundaries) + 1
        : input.text.length;
    const rawSentence = input.text.slice(sentenceStart, sentenceEnd);
    const leadingWhitespace = rawSentence.match(/^\s*/)?.[0].length ?? 0;
    const sourceStart = sentenceStart + leadingWhitespace;
    const sourceText = rawSentence.trim();
    const normalizedLine = sourceText.toLowerCase();
    const ranked = responsibilities
      .map((responsibility) => ({
        responsibility,
        score: meaningfulTitleWords(responsibility.title).filter((word) =>
          normalizedLine.includes(word),
        ).length,
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score);
    if (!ranked.length || ranked[1]?.score === ranked[0].score) continue;
    const minimum = durationNumber(match[1]);
    const maximum = durationNumber(match[2]);
    if (!minimum || !maximum || maximum < minimum) continue;
    const multiplier = /^h/i.test(match[3]) ? 60 : 1;
    ranked[0].responsibility.duration = {
      minimumMinutes: Math.round(minimum * multiplier),
      maximumMinutes: Math.round(maximum * multiplier),
      explicit: true,
    };
    addFactEvidence(ranked[0].responsibility, sourceText, sourceStart);
  }
}

/** Attach a source-explicit "actual/final submission" continuation to its work. */
function recoverAnaphoricFinalDeadlines(
  input: ExtractionInput,
  responsibilities: Responsibility[],
): void {
  const sentencePattern = /[^.!?\r\n]+[.!?]?/g;
  for (const sentenceMatch of input.text.matchAll(sentencePattern)) {
    if (sentenceMatch.index === undefined) continue;
    const leadingWhitespace = sentenceMatch[0].match(/^\s*/)?.[0].length ?? 0;
    const sourceText = sentenceMatch[0].trim();
    const sourceStart = sentenceMatch.index + leadingWhitespace;
    if (
      !/\b(?:actual|final)\s+(?:submission|deadline|due\s+date)\b/i.test(
        sourceText,
      )
    ) {
      continue;
    }
    const dateMatch =
      /\b((?:(?:next|this)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday))(?:\s+at\s+(midnight|noon|\d{1,2}(?::\d{2})?\s*(?:am|pm)))?\b/i.exec(
        sourceText,
      );
    if (!dateMatch) continue;
    const date = /^next\s+/i.test(dateMatch[1])
      ? nextWeekday(input.currentLocalDate, dateMatch[2].toLowerCase())
      : resolveRelativeDate(
          dateMatch[1],
          input.currentLocalDate,
          input.timeZone,
        ).date;
    if (!date) continue;
    const time = dateMatch[3]
      ? /midnight/i.test(dateMatch[3])
        ? "23:59"
        : /noon/i.test(dateMatch[3])
          ? "12:00"
          : parseClockTime(dateMatch[3])
      : undefined;
    const sourceEnd = sourceStart + sourceText.length;
    const alreadyRepresented = responsibilities.some((responsibility) => {
      if (responsibility.deadline?.strength !== "hard") return false;
      const range = sourceRange(input, responsibility);
      return range && range.start < sourceEnd && range.end > sourceStart;
    });
    if (alreadyRepresented) continue;
    const candidate = responsibilities
      .filter((responsibility) => {
        if (responsibility.kind !== "task") return false;
        if (
          /\b(?:look\s+at|review|check|go\s+over)\b/i.test(
            `${responsibility.title} ${responsibility.sourceText}`,
          )
        ) {
          return false;
        }
        const range = sourceRange(input, responsibility);
        return range && range.start < sourceStart;
      })
      .sort((left, right) => {
        const leftRange = sourceRange(input, left);
        const rightRange = sourceRange(input, right);
        return (rightRange?.end ?? 0) - (leftRange?.end ?? 0);
      })[0];
    if (!candidate) continue;
    if (candidate.deadline?.strength === "soft") {
      candidate.constraints = {
        ...candidate.constraints,
        preferredWindows: [
          ...(candidate.constraints?.preferredWindows ?? []),
          {
            date: candidate.deadline.date,
            ...(candidate.deadline.period
              ? { period: candidate.deadline.period }
              : {}),
            label:
              candidate.deadline.period ?? "Earlier preferred completion",
          },
        ],
      };
    }
    candidate.deadline = {
      date,
      ...(time ? { time } : {}),
      strength: "hard",
      confidence: 0.98,
    };
    addFactEvidence(candidate, sourceText, sourceStart);
  }
}

/** Fill a plainly stated named completion date when one AI identity matches. */
function recoverNamedCompletionDeadlines(
  input: ExtractionInput,
  responsibilities: Responsibility[],
): void {
  const clausePattern = /[^,;.!?\r\n]+/g;
  const deadlinePattern =
    /\b(?:is\s+|are\s+|needs?\s+to\s+be\s+|must\s+be\s+)?(?:due|done|ready|finished|sent|submitted)\s+(?:by|on)\s+((?:(?:next|this)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday))(?:\s+(morning|afternoon|evening|night)|\s+at\s+(midnight|noon|\d{1,2}(?::\d{2})?\s*(?:am|pm)))?/i;
  for (const clauseMatch of input.text.matchAll(clausePattern)) {
    if (clauseMatch.index === undefined) continue;
    const leadingWhitespace = clauseMatch[0].match(/^\s*/)?.[0].length ?? 0;
    const sourceText = clauseMatch[0].trim();
    const match = deadlinePattern.exec(sourceText);
    if (!match) continue;
    const subject = sourceText.slice(0, match.index).toLowerCase();
    const ranked = responsibilities
      .filter(
        (responsibility) =>
          responsibility.kind === "task" &&
          responsibility.deadline?.strength !== "hard",
      )
      .map((responsibility) => ({
        responsibility,
        score: meaningfulTitleWords(responsibility.title).filter((word) =>
          subject.includes(word),
        ).length,
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score);
    if (!ranked.length || ranked[1]?.score === ranked[0].score) continue;
    const date = /^next\s+/i.test(match[1])
      ? nextWeekday(input.currentLocalDate, match[2].toLowerCase())
      : resolveRelativeDate(
          match[1],
          input.currentLocalDate,
          input.timeZone,
        ).date;
    if (!date) continue;
    const timeText = match[4];
    const time = timeText
      ? /midnight/i.test(timeText)
        ? "23:59"
        : /noon/i.test(timeText)
          ? "12:00"
          : parseClockTime(timeText)
      : undefined;
    ranked[0].responsibility.deadline = {
      date,
      ...(time ? { time } : {}),
      ...(match[3] ? { period: match[3] } : {}),
      strength: "hard",
      confidence: 0.96,
    };
    addFactEvidence(
      ranked[0].responsibility,
      sourceText,
      clauseMatch.index + leadingWhitespace,
    );
  }
}

function upsertRelation(
  draft: SemanticDraft,
  relation: SemanticDraft["relations"][number],
): void {
  draft.relations = draft.relations.filter(
    (candidate) =>
      !(
        candidate.fromId === relation.fromId &&
        candidate.toId === relation.toId
      ),
  );
  draft.relations.push(relation);
}

function recoverExplicitDeadlineClock(
  responsibility: Responsibility,
): void {
  if (!responsibility.deadline) return;
  const evidence = [
    responsibility.sourceText,
    ...(responsibility.factEvidence ?? []).map((item) => item.sourceText),
  ].join(" ");
  const clockText =
    /\b(?:due|deadline)\b[^.!?\r\n]{0,60}\b(?:at|by)\s+(midnight|noon|\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i.exec(
      evidence,
    )?.[1] ??
    /\bno\s+later\s+than\s+(midnight|noon|\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i.exec(
      evidence,
    )?.[1];
  if (!clockText) return;
  const time = /midnight/i.test(clockText)
    ? "23:59"
    : /noon/i.test(clockText)
      ? "12:00"
      : parseClockTime(clockText);
  if (time) responsibility.deadline.time = time;
}

function recoverExplicitRecurringException(
  input: ExtractionInput,
  draft: SemanticDraft,
): void {
  const match =
    /([^.!?\r\n]*\bnext\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b[^.!?\r\n]*?),\s*so\s+(move\s+that\s+session\s+earlier\b[^.!?\r\n]*?instead\s+of\s+skipping\s+it)/i.exec(
      input.text,
    );
  if (!match) return;
  const recurring = draft.responsibilities
    .filter((item) => item.recurrence)
    .map((responsibility) => ({
      responsibility,
      range: sourceRange(input, responsibility),
    }))
    .filter(
      (item) =>
        !item.range || match.index === undefined || item.range.start <= match.index,
    )
    .sort(
      (left, right) => (right.range?.end ?? 0) - (left.range?.end ?? 0),
    );
  const responsibility = recurring[0]?.responsibility;
  if (!responsibility) return;
  if (
    responsibility.conditionalRules?.some((rule) =>
      /instead\s+of\s+skipping/i.test(rule.effect),
    )
  ) {
    return;
  }
  responsibility.conditionalRules = [
    ...(responsibility.conditionalRules ?? []),
    {
      condition: match[1].trim(),
      effect: match[2].trim(),
      requiresReview: false,
    },
  ];
}

function recoverExplicitRecurringWeekdays(
  input: ExtractionInput,
  responsibilities: Responsibility[],
): void {
  const match = /\bevery\b([^.!?\r\n]{0,160})/i.exec(input.text);
  if (!match) return;
  const days = [
    ...match[1].matchAll(
      /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
    ),
  ].map((item) => item[1].toLowerCase()) as NonNullable<
    NonNullable<Responsibility["recurrence"]>["daysOfWeek"]
  >;
  const recurring = responsibilities
    .filter((item) => item.recurrence)
    .map((responsibility) => ({
      responsibility,
      range: sourceRange(input, responsibility),
    }))
    .sort(
      (left, right) =>
        (left.range?.start ?? Number.MAX_SAFE_INTEGER) -
        (right.range?.start ?? Number.MAX_SAFE_INTEGER),
    );
  const recurrence = recurring[0]?.responsibility.recurrence;
  if (recurrence?.exactTimes?.length) {
    // Exact time rules already identify their active weekdays. Re-scanning an
    // "except Friday and Saturday" clause here would turn exclusions into the
    // top-level inclusion filter and make every valid occurrence disappear.
    return;
  }
  if (recurrence && days.length >= 2) {
    recurrence.daysOfWeek = [...new Set(days)];
  }
}

function removeImpossibleEstimatedPlacements(
  input: ExtractionInput,
  responsibilities: Responsibility[],
): void {
  responsibilities.forEach((responsibility) => {
    const preferred = responsibility.constraints?.preferredWindows;
    if (!preferred?.length) return;
    responsibility.constraints!.preferredWindows = preferred.filter(
      (window) =>
        !/\bAI estimated placement\b/i.test(window.label) ||
        !window.date ||
        (window.date >= input.currentLocalDate &&
          (!responsibility.deadline?.date ||
            window.date <= responsibility.deadline.date)),
    );
  });
}

/** Preserve source-explicit shipping math after AI has identified the actors. */
function recoverLeadTimeRelations(
  input: ExtractionInput,
  draft: SemanticDraft,
): void {
  const leadTime =
    /\b(?:shipping|delivery|processing|transit|lead\s+time)\b[^.!?\r\n]{0,100}\b(?:takes?|requires?)\s+(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s*(days?|weeks?)\b/i.exec(
      input.text,
    );
  const arrival =
    /\b(?:need|must\s+have)\s+(?:the\s+)?([a-z][a-z0-9 '\u2019-]{1,60}?)\s+by\s+((?:next|this)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+at\s+(midnight|noon|\d{1,2}(?::\d{2})?\s*(?:am|pm)))?/i.exec(
      input.text,
    );
  if (!leadTime || !arrival) return;
  const maximum = durationNumber(leadTime[2]);
  if (!maximum) return;
  const subjectWords = arrival[1]
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3);
  const subjectMatches = (responsibility: Responsibility) => {
    const title = responsibility.title.toLowerCase();
    return subjectWords.some((word) => title.includes(word));
  };
  const milestones = draft.responsibilities.filter(
    (responsibility) =>
      responsibility.kind === "milestone" && subjectMatches(responsibility),
  );
  const orders = draft.responsibilities.filter(
    (responsibility) =>
      responsibility.kind === "task" &&
      /\b(?:order|purchase|book|request)\b/i.test(responsibility.title) &&
      subjectMatches(responsibility),
  );
  if (milestones.length !== 1 || orders.length !== 1) return;
  const milestone = milestones[0];
  const order = orders[0];
  const date = /^next\s+/i.test(`${arrival[2] ?? ""}${arrival[3]}`)
    ? nextWeekday(input.currentLocalDate, arrival[3].toLowerCase())
    : resolveRelativeDate(
        `${arrival[2] ?? ""}${arrival[3]}`.trim(),
        input.currentLocalDate,
        input.timeZone,
      ).date;
  if (date) {
    const timeText = arrival[4];
    const time = timeText
      ? /midnight/i.test(timeText)
        ? "23:59"
        : /noon/i.test(timeText)
          ? "12:00"
          : parseClockTime(timeText)
      : undefined;
    milestone.deadline = {
      date,
      ...(time ? { time } : {}),
      strength: "hard",
      confidence: 0.98,
    };
    if (arrival.index !== undefined) {
      addFactEvidence(milestone, arrival[0], arrival.index);
    }
  }
  if (!/\b(?:order|purchase|book|request)\b[^.!?\r\n]{0,80}\bby\b/i.test(order.sourceText)) {
    order.deadline = undefined;
  }
  const unitMinutes = /^week/i.test(leadTime[3]) ? 7 * 24 * 60 : 24 * 60;
  upsertRelation(draft, {
    fromId: order.id,
    toId: milestone.id,
    relation: "before",
    strength: "hard",
    minimumGapMinutes: Math.round(maximum * unitMinutes),
    sourceText: input.text,
    timing: "ordering",
    fromBoundary: "end",
    toBoundary: "start",
    mode: "latest",
    reason: `Use the conservative maximum from the stated ${leadTime[0]}.`,
  });

  const prerequisite =
    /\b(?:once|after|when)\s+(?:the\s+)?([a-z][a-z0-9 '\u2019-]{1,80}?)\s+(?:is|has\s+been)\s+(?:finalized|approved|completed|confirmed|decided|selected|ready)\b/i.exec(
      input.text,
    );
  if (!prerequisite) return;
  const prerequisiteWords = prerequisite[1]
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3);
  const prerequisiteTasks = draft.responsibilities.filter(
    (responsibility) =>
      responsibility.kind === "task" &&
      responsibility.id !== order.id &&
      prerequisiteWords.some((word) =>
        responsibility.title.toLowerCase().includes(word),
      ),
  );
  if (prerequisiteTasks.length === 1) {
    upsertRelation(draft, {
      fromId: prerequisiteTasks[0].id,
      toId: order.id,
      relation: "before",
      strength: "hard",
      reason: prerequisite[0],
      sourceText: input.text,
      timing: "ordering",
    });
  }
}

function normalizeNextWeekScope(
  input: ExtractionInput,
  responsibilities: Responsibility[],
): void {
  responsibilities.forEach((responsibility) => {
    const range = sourceRange(input, responsibility);
    if (!range) return;
    const paragraph = paragraphAt(input.text, range.start);
    const context = input.text.slice(paragraph.start, range.end);
    if (!/\bnext\s+week\b/i.test(context)) return;
    const scopedWeekdays = bareWeekdays(responsibility.sourceText);
    if (!scopedWeekdays.size) return;
    setScopedDates(responsibility, scopedWeekdays, input.currentLocalDate);
  });
}

function explicitContextDate(
  input: ExtractionInput,
  responsibility: Responsibility,
): { date: string; label: string } | undefined {
  const own = responsibility.sourceText.match(
    /\b(today|tomorrow|(?:(?:this|next)\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i,
  )?.[1];
  if (own) {
    const resolved = resolveRelativeDate(
      own,
      input.currentLocalDate,
      input.timeZone,
    );
    if (resolved.date && !resolved.ambiguous) return { date: resolved.date, label: own };
  }

  const range = sourceRange(input, responsibility);
  if (!range) return undefined;
  const before = input.text.slice(0, range.start);
  const headings = [
    ...before.matchAll(
      /(?:^|\r?\n)\s*(?:on\s+)?(today|tomorrow|(?:(?:this|next)\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b(?:\s*\((?:today|tomorrow)\))?(?:\s*:?\s*$|[^\r\n:]+:\s*$)/gim,
    ),
  ];
  const heading = headings.at(-1)?.[1];
  if (!heading) return undefined;
  const resolved = resolveRelativeDate(
    heading,
    input.currentLocalDate,
    input.timeZone,
  );
  return resolved.date && !resolved.ambiguous
    ? { date: resolved.date, label: `${heading} context` }
    : undefined;
}

function responsibilityHasDate(responsibility: Responsibility): boolean {
  return Boolean(
    responsibility.deadline?.date ||
      responsibility.occurrence?.date ||
      responsibility.recurrence?.startDate ||
      responsibility.constraints?.allowedWindows?.some((window) => window.date) ||
      responsibility.constraints?.preferredWindows?.some((window) => window.date) ||
      responsibility.constraints?.earliestStart?.date ||
      responsibility.constraints?.latestEnd?.date,
  );
}

function attachSharedDateContext(
  input: ExtractionInput,
  responsibilities: Responsibility[],
): void {
  responsibilities.forEach((responsibility) => {
    if (responsibilityHasDate(responsibility) || responsibility.recurrence) return;
    const context = explicitContextDate(input, responsibility);
    if (!context) return;
    if (responsibility.occurrence) {
      responsibility.occurrence.date = context.date;
      return;
    }
    const constraints = responsibility.constraints ?? {};
    const allowedWindows = constraints.allowedWindows ?? [];
    const preferredWindows = constraints.preferredWindows ?? [];
    responsibility.constraints = {
      ...constraints,
      allowedWindows: allowedWindows.length
        ? allowedWindows.map((window) => ({
            ...window,
            date: window.date ?? context.date,
          }))
        : [{ date: context.date, label: context.label }],
      ...(preferredWindows.length
        ? {
            preferredWindows: preferredWindows.map((window) => ({
              ...window,
              date: window.date ?? context.date,
            })),
          }
        : {}),
    };
    if (responsibility.constraints.latestEnd) {
      responsibility.constraints.latestEnd.date ??= context.date;
    }
    if (responsibility.constraints.earliestStart) {
      responsibility.constraints.earliestStart.date ??= context.date;
    }
  });
}

function isDeadlineOnlyContinuation(responsibility: Responsibility): boolean {
  return Boolean(
    responsibility.deadline &&
      !responsibility.occurrence &&
      !responsibility.duration &&
      !responsibility.recurrence &&
      !responsibility.conditionalRules?.length &&
      ANAPHORIC_CONTINUATION.test(responsibility.sourceText),
  );
}

/** Recover a plainly stated soft planning window when AI kept the task but
 * omitted that preference. This is intentionally limited to preference
 * language and never converts a due/deadline clause into a soft window. */
function recoverExplicitSoftDatePreferences(
  input: ExtractionInput,
  responsibilities: Responsibility[],
): void {
  const preferencePattern =
    /(?:^|[.!?]\s*)([^.!?\r\n]*(?:should\s+(?:probably\s+)?|would\s+(?:like|rather)\s+to\s+|want\s+to\s+|plan\s+to\s+|try\s+to\s+)[^.!?\r\n]*\b(early\s+next\s+week)\b[^.!?\r\n]*)/gi;
  for (const match of input.text.matchAll(preferencePattern)) {
    if (match.index === undefined) continue;
    const clause = match[1].trim();
    const label = match[2];
    const labelEnd =
      clause.toLowerCase().indexOf(label.toLowerCase()) + label.length;
    // A hard boundary after the preference does not erase it. Only reject a
    // due/deadline construction that leads into the recovered period itself.
    if (HARD_DEADLINE_WORDING.test(clause.slice(0, labelEnd))) continue;

    const clauseStart = input.text.indexOf(clause, match.index);
    if (clauseStart < 0) continue;
    const clauseEnd = clauseStart + clause.length;
    const clauseWords = new Set(
      clause.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
    );
    const ranked = responsibilities
      .filter((responsibility) => {
        if (responsibility.kind !== "task") return false;
        const range = sourceRange(input, responsibility);
        return range && range.start < clauseEnd && range.end > clauseStart;
      })
      .map((responsibility) => ({
        responsibility,
        score: meaningfulTitleWords(responsibility.title).filter((word) =>
          clauseWords.has(word),
        ).length,
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score);
    if (!ranked.length || ranked[1]?.score === ranked[0].score) continue;
    const responsibility = ranked[0].responsibility;
    const date = format(
      startOfWeek(addWeeks(parseISO(input.currentLocalDate), 1), {
        weekStartsOn: 1,
      }),
      "yyyy-MM-dd",
    );
    const namedPeriod = new RegExp(
      `\\b${label.trim().replace(/\s+/g, "\\s+")}\\b`,
      "i",
    );
    const existingWindows = responsibility.constraints?.preferredWindows ?? [];
    const unrelatedWindows = existingWindows.filter(
      (window) =>
        !namedPeriod.test(`${window.period ?? ""} ${window.label}`),
    );
    responsibility.constraints = {
      ...responsibility.constraints,
      preferredWindows: [
        ...unrelatedWindows,
        // The source-relative period is authoritative over an AI-resolved
        // date or invented clock boundaries carrying the same period label.
        { date, period: label, label },
      ],
    };
    addFactEvidence(responsibility, clause, clauseStart);
  }
}

function mergeAnaphoricDeadlines(
  input: ExtractionInput,
  draft: SemanticDraft,
): void {
  const removed = new Set<string>();
  const ordered = draft.responsibilities
    .map((responsibility, index) => ({
      responsibility,
      index,
      range: sourceRange(input, responsibility),
    }))
    .sort(
      (left, right) =>
        (left.range?.start ?? left.index) - (right.range?.start ?? right.index),
    );

  ordered.forEach((entry, orderedIndex) => {
    const current = entry.responsibility;
    if (!isDeadlineOnlyContinuation(current)) return;
    const previous = ordered
      .slice(0, orderedIndex)
      .reverse()
      .find(
        (candidate) =>
          !removed.has(candidate.responsibility.id) &&
          candidate.responsibility.kind === "task",
      );
    if (!previous || !current.deadline) return;

    const prior = previous.responsibility;
    if (prior.deadline?.strength === "soft") {
      const periodMatch = prior.sourceText.match(
        /\b(early\s+next\s+week|next\s+week|this\s+weekend|weekend)\b/i,
      );
      if (periodMatch) {
        const preferredDate = /next\s+week/i.test(periodMatch[1])
          ? format(
              startOfWeek(addWeeks(parseISO(input.currentLocalDate), 1), {
                weekStartsOn: 1,
              }),
              "yyyy-MM-dd",
            )
          : prior.deadline.date;
        prior.constraints = {
          ...prior.constraints,
          preferredWindows: [
            ...(prior.constraints?.preferredWindows ?? []),
            {
              date: preferredDate,
              period: periodMatch[1],
              label: periodMatch[1],
            },
          ],
        };
      }
    }
    prior.deadline = current.deadline;
    prior.factEvidence = [
      ...(prior.factEvidence ?? []),
      ...(current.factEvidence ?? []),
    ].filter(
      (evidence, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.sourceStart === evidence.sourceStart &&
            candidate.sourceEnd === evidence.sourceEnd,
        ) === index,
    );
    prior.missingInformation = [
      ...new Set([...prior.missingInformation, ...current.missingInformation]),
    ];
    prior.reviewRequired ||= current.reviewRequired;
    prior.confidence = Math.min(prior.confidence, current.confidence);

    const priorRange = sourceRange(input, prior);
    const currentRange = sourceRange(input, current);
    if (priorRange && currentRange && currentRange.start >= priorRange.start) {
      prior.sourceStart = priorRange.start;
      prior.sourceEnd = currentRange.end;
      prior.sourceText = input.text.slice(priorRange.start, currentRange.end);
    }

    draft.relations.forEach((relation) => {
      if (relation.fromId === current.id) relation.fromId = prior.id;
      if (relation.toId === current.id) relation.toId = prior.id;
    });
    removed.add(current.id);
  });

  if (removed.size) {
    draft.responsibilities = draft.responsibilities.filter(
      (responsibility) => !removed.has(responsibility.id),
    );
    draft.relations = draft.relations.filter(
      (relation) => relation.fromId !== relation.toId,
    );
  }
}

/** Source-grounded consistency repairs between AI fact extraction and compile. */
export function normalizeSemanticDraft(
  input: ExtractionInput,
  original: SemanticDraft,
  excludedIds: ReadonlySet<string> = new Set(),
  recoverRelationshipHints = true,
): SemanticDraft {
  const draft = structuredClone(original);
  const untouched = draft.responsibilities.filter((item) => excludedIds.has(item.id));
  draft.responsibilities = draft.responsibilities.filter((item) => !excludedIds.has(item.id));
  recoverExplicitDurationRanges(input, draft.responsibilities);
  recoverExplicitSingleDurations(input, draft.responsibilities);
  recoverNamedCompletionDeadlines(input, draft.responsibilities);
  recoverAnaphoricFinalDeadlines(input, draft.responsibilities);
  if (recoverRelationshipHints && !excludedIds.size) recoverLeadTimeRelations(input, draft);
  recoverExplicitRecurringException(input, draft);
  recoverExplicitRecurringWeekdays(input, draft.responsibilities);
  removeImpossibleEstimatedPlacements(input, draft.responsibilities);
  draft.responsibilities.forEach((responsibility) => {
    recoverExplicitDeadlineClock(responsibility);
    if (
      responsibility.kind === "task" &&
      responsibility.deadline?.time === "00:00" &&
      /\bmidnight\b/i.test(responsibility.sourceText)
    ) {
      responsibility.deadline.time = "23:59";
    }
    if (
      responsibility.deadline?.strength === "soft" &&
      HARD_DEADLINE_WORDING.test(responsibility.sourceText)
    ) {
      responsibility.deadline.strength = "hard";
    }
  });
  normalizeNextWeekScope(input, draft.responsibilities);
  recoverExplicitSoftDatePreferences(input, draft.responsibilities);
  mergeAnaphoricDeadlines(input, draft);
  normalizeNextWeekScope(input, draft.responsibilities);
  normalizePostWeekendWeekdays(input, draft.responsibilities);
  normalizeExplicitRelativeWeekdays(input, draft.responsibilities);
  normalizeUnscopedBareWeekdays(input, draft.responsibilities);
  attachSharedDateContext(input, draft.responsibilities);
  if (untouched.length) {
    const byId = new Map([...draft.responsibilities, ...untouched].map((item) => [item.id, item]));
    draft.responsibilities = original.responsibilities.flatMap((item) => byId.has(item.id) ? [byId.get(item.id)!] : []);
  }
  return draft;
}
