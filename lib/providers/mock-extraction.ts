import {
  addDays,
  addWeeks,
  addHours,
  differenceInCalendarDays,
  endOfWeek,
  format,
  parseISO,
  startOfWeek,
} from "date-fns";
import { fromZonedTime } from "date-fns-tz";
import {
  resolveRelativeDate,
  type InterpretedDate,
} from "@/lib/domain/date-interpretation";
import { validateAndDedupeExtraction } from "@/lib/domain/extraction-schema";
import type {
  ExtractedTask,
  ExtractionInput,
  ExtractionResult,
  TaskCategory,
  TaskPriority,
} from "@/lib/domain/types";
import type { TaskExtractionProvider } from "./task-extraction";
import { dayAgendaDateContext } from "./day-agenda";
import {
  parseTimedRecurrence,
  type ParsedTimedRecurrence,
} from "./timed-recurrence";

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
};

function clockRangeMinutes(text: string): number | undefined {
  const match = /\bfrom\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(
    text,
  );
  if (!match) return undefined;
  const meridiem = (match[3] ?? match[6]).toLocaleLowerCase();
  const asMinutes = (hourText: string, minuteText: string | undefined, period: string) => {
    let hour = Number(hourText);
    const minute = Number(minuteText ?? 0);
    if (hour < 1 || hour > 12 || minute > 59) return undefined;
    if (period === "am" && hour === 12) hour = 0;
    if (period === "pm" && hour !== 12) hour += 12;
    return hour * 60 + minute;
  };
  const start = asMinutes(match[1], match[2], match[3]?.toLocaleLowerCase() ?? meridiem);
  const end = asMinutes(match[4], match[5], match[6].toLocaleLowerCase());
  if (start === undefined || end === undefined) return undefined;
  const duration = end > start ? end - start : end + 24 * 60 - start;
  return duration > 0 && duration <= 12 * 60 ? duration : undefined;
}

function estimateMinutes(text: string): {
  minutes: number;
  confidence: number;
  assumed: boolean;
  source: "stated" | "heuristic";
  rationale: string;
} {
  const rangeMinutes = clockRangeMinutes(text);
  if (rangeMinutes) {
    return {
      minutes: rangeMinutes,
      confidence: 0.98,
      assumed: false,
      source: "stated",
      rationale: "Used the start and end times stated for each occurrence.",
    };
  }
  const hours = /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)/i.exec(text);
  if (hours) {
    return {
      minutes: Math.round(Number(hours[1]) * 60),
      confidence: 0.98,
      assumed: false,
      source: "stated",
      rationale: "Used the duration stated in the source text.",
    };
  }
  const minutes = /(\d+)\s*(?:minutes?|mins?)/i.exec(text);
  if (minutes) {
    return {
      minutes: Number(minutes[1]),
      confidence: 0.98,
      assumed: false,
      source: "stated",
      rationale: "Used the duration stated in the source text.",
    };
  }
  const lower = text.toLocaleLowerCase();
  if (/exam|study|essay|report|proposal/.test(lower)) {
    return {
      minutes: 90,
      confidence: 0.46,
      assumed: true,
      source: "heuristic",
      rationale: "Used a conservative local estimate for substantial focused work.",
    };
  }
  if (/gym|work\s*out|workout|run|appointment/.test(lower)) {
    return {
      minutes: 60,
      confidence: 0.48,
      assumed: true,
      source: "heuristic",
      rationale: "Used a typical local estimate for this kind of activity.",
    };
  }
  return {
    minutes: 45,
    confidence: 0.42,
    assumed: true,
    source: "heuristic",
    rationale: "Used a conservative default because no duration was stated.",
  };
}

function categoryFor(text: string): TaskCategory {
  const lower = text.toLocaleLowerCase();
  if (/essay|homework|exam|study|class|chemistry|reading/.test(lower)) {
    return "school";
  }
  if (/meeting|report|client|proposal|email/.test(lower)) return "work";
  if (/gym|work\s*out|workout|run|yoga/.test(lower)) return "fitness";
  if (/doctor|dentist|therapy|medication/.test(lower)) return "health";
  if (/buy|pick up|pickup|store|errand|groceries/.test(lower)) return "errand";
  return "personal";
}

function markdownText(text: string): string {
  return text
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/<[^>]+>/g, " ")
    .replace(/!?\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/<https?:\/\/[^>]+>/gi, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[*_~`#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceFragments(text: string): string[] {
  const normalized = text
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*li\b[^>]*>/gi, "• ")
    .replace(/<\s*\/\s*(?:p|div|li|tr|h[1-6])\s*>/gi, "\n");
  return normalized
    .split(/\r?\n|(?<=[.!?])\s+(?=[A-Z])/)
    .flatMap((line) =>
      line
        .replace(
          /\s+(?=\d+[.)]\s+(?:apply|approve|book|call|complete|confirm|email|pay|read|reply|respond|review|send|sign|submit|upload)\b)/gi,
          "\n",
        )
        .split(
          /\s*;\s*(?=(?:\d+[.)]|\[[ xX]\]|[☐□⬜🔲•▪‣→])\s*)/u,
        ),
    )
    .map((line) => line.trim())
    .filter(Boolean);
}

function actionableEmailSubject(text: string): string | undefined {
  const match = /^subject\s*:\s*(.+)$/i.exec(text.trim());
  if (!match) return undefined;
  const subject = match[1].trim();
  return /\b(?:action required|approval required|response required|please|urgent|asap|apply|approve|book|call|complete|confirm|pay|reply|respond|review|rsvp|send|sign|submit|upload)\b/i.test(
    subject,
  )
    ? subject
    : undefined;
}

function semanticText(line: string): string {
  let value = line;
  if (/^\s*\|.*\|\s*$/.test(value)) {
    const cells = value
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean);
    if (cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))) {
      return "";
    }
    value = cells.join(" ");
  }

  const subject = actionableEmailSubject(value);
  if (subject) value = subject;

  return markdownText(value)
    .replace(/^\[[^\]]+\]\s*[^:]{1,40}:\s*/u, "")
    .replace(
      /^[\p{L}][\p{L}\p{N} .'-]{0,30}:\s+(?=(?:please|kindly|can you|could you|would you|remember to|don't forget to|apply|approve|book|call|complete|confirm|pay|reply|respond|review|rsvp|send|sign|submit|upload)\b)/iu,
      "",
    )
    .replace(/^(?:task|to-?do|action item)\s*:\s*/i, "")
    .replace(/\b(?:due|deadline|estimate|duration|effort)\s*:\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function agendaRangeMinutes(startText: string, endText: string): number | undefined {
  const parseValue = (value: string, fallbackPeriod?: string) => {
    const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(value.trim());
    if (!match) return undefined;
    let hour = Number(match[1]);
    const minute = Number(match[2] ?? 0);
    const period = (match[3] ?? fallbackPeriod)?.toLocaleLowerCase();
    if (minute > 59 || hour > (period ? 12 : 23)) return undefined;
    if (period === "am" && hour === 12) hour = 0;
    if (period === "pm" && hour !== 12) hour += 12;
    return hour * 60 + minute;
  };
  const endPeriod = /\b(am|pm)\b/i.exec(endText)?.[1];
  const start = parseValue(startText, endPeriod);
  const end = parseValue(endText);
  if (start === undefined || end === undefined) return undefined;
  const duration = end > start ? end - start : end + 24 * 60 - start;
  return duration > 0 && duration <= 12 * 60 ? duration : undefined;
}

const LEADING_GERUND: Record<string, string> = {
  applying: "apply",
  booking: "book",
  buying: "buy",
  calling: "call",
  cleaning: "clean",
  completing: "complete",
  drafting: "draft",
  emailing: "email",
  fixing: "fix",
  paying: "pay",
  preparing: "prepare",
  reading: "read",
  registering: "register",
  renewing: "renew",
  replying: "reply",
  reviewing: "review",
  scheduling: "schedule",
  sending: "send",
  signing: "sign",
  studying: "study",
  submitting: "submit",
  updating: "update",
  uploading: "upload",
  writing: "write",
};

function cleanConversationalOpening(value: string): string {
  const cleaned = value
    .replace(/^(?:hey|hi|yo|ugh|okay|ok)[\s,!—–-]+/i, "")
    .replace(/^(?:maybe\s+)?(?:someday\s+)?/i, "")
    .replace(/^i[’']d\s+like\s+to\s+/i, "")
    .replace(/^(?:would|could|do)\s+you\s+mind\s+(?:please\s+)?/i, "")
    .replace(
      /^(?:(?:please|kindly|pls)\s+)?(?:can|could|would|will)\s+(?:you|u)\s+(?:please\s+)?(?:remind me to\s+)?/i,
      "",
    )
    .replace(/^(?:please|kindly|pls)\s+(?:remind me to\s+)?/i, "")
    .replace(
      /^i\s+(?:(?:really|probably|just)\s+)*(?:should|need|want|have|(?:would|’d|'d)\s+like)(?:(?:\s+probably)?\s+get\s+around)?\s+to\s+/i,
      "",
    )
    .replace(/^i\s+(?:(?:really|probably|just)\s+)*gotta\s+/i, "")
    .replace(/^asap\s*[—–,:-]*\s*/i, "")
    .trim();
  const leadingWord = /^([\p{L}]+)(\b.*)$/u.exec(cleaned);
  const base = leadingWord
    ? LEADING_GERUND[leadingWord[1].toLocaleLowerCase()]
    : undefined;
  return base && leadingWord
    ? `${base}${leadingWord[2]}`
    : cleaned;
}

function titleFor(text: string, datePhrase?: string): string {
  return cleanConversationalOpening(
    markdownText(text)
    .replace(
      /^\s*(?:[-*•▪‣→☐□⬜🔲]|\d+[.)]|[ivxlcdm]+[.)]|\[[ xX]\])\s*/iu,
      "",
    )
    .replace(/^(?:task|to-?do|action item|action required|reminder)\s*:\s*/i, "")
    .replace(
      /^(?:make sure to|remember to|don't forget to)\s+/i,
      "",
    )
    .replace(datePhrase ?? /$^/, " ")
    .replace(/\s*\(\s*overdue\s*\)\s*/gi, " ")
    .replace(
      /\b(?:by|before|on|due(?:\s+on)?)\s*(?=[,;:.!?—–-]*$)/i,
      "",
    )
    .replace(/\b(?:for\s+)?\d+(?:\.\d+)?\s*(?:hours?|hrs?|minutes?|mins?)(?:\s+each)?\b/gi, " ")
    .replace(
      /[.!?]\s*(?:(?:it|this|that)\s+)?(?:should|will|would|could|might|may|probably|roughly|likely|only)*\s*(?:take|takes|need|needs|require|requires|run)[\s.!?]*$/i,
      "",
    )
    .replace(
      /\b(?:by|before|on|due(?:\s+on)?)\s*(?=[,;:.!?—–-]*$)/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s,;:.!?—–-]+$/, ""),
  );
}

function recurrenceCount(text: string): number | undefined {
  const match = /\b(one|two|three|four|five|six|seven|\d+)\s+times?\b/i.exec(
    text,
  );
  if (!match) {
    return /\b(?:every\s+(?:other|second|2(?:nd)?)\s+day|on\s+alternate\s+days?|alternat(?:e|ing)\b.{0,40}\bdays?|day\s+on[\s,/-]+day\s+off)\b/i.test(
      text,
    )
      ? 4
      : undefined;
  }
  return NUMBER_WORDS[match[1].toLocaleLowerCase()] ?? Number(match[1]);
}

function extractDatePhrase(text: string): string | undefined {
  const timeSuffix =
    "(?:\\s+(?:at\\s+)?(?:\\d{1,2}:\\d{2}(?:\\s*(?:am|pm))?|\\d{1,2}\\s*(?:am|pm)))?";
  const patterns = [
    new RegExp(`\\b(?:today|tomorrow|tonight)${timeSuffix}`, "i"),
    new RegExp(
      `\\b(?:next\\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)${timeSuffix}`,
      "i",
    ),
    new RegExp(`\\b\\d{4}-\\d{1,2}-\\d{1,2}${timeSuffix}`, "i"),
    new RegExp(`\\b\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?${timeSuffix}`, "i"),
    new RegExp(
      `\\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?${timeSuffix}`,
      "i",
    ),
    new RegExp(
      `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:,?\\s+\\d{4})?${timeSuffix}`,
      "i",
    ),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match[0].trim();
  }
  return undefined;
}

function localWeekWindow(
  currentLocalDate: string,
  timeZone: string,
  text = "",
): { start: string; end: string } {
  const localReference = new Date(`${currentLocalDate}T12:00:00`);
  const start = addWeeks(
    startOfWeek(localReference, { weekStartsOn: 1 }),
    /\bnext\s+week\b/i.test(text) ? 1 : 0,
  );
  const end = endOfWeek(start, { weekStartsOn: 1 });
  return {
    start: fromZonedTime(
      `${format(start, "yyyy-MM-dd")}T00:00:00`,
      timeZone,
    ).toISOString(),
    end: fromZonedTime(
      `${format(end, "yyyy-MM-dd")}T23:59:59`,
      timeZone,
    ).toISOString(),
  };
}

function isFixedEvent(text: string): boolean {
  if (
    /\b(?:book|cancel|choose|confirm|request|reschedule|schedule|select)\b.{0,80}\b(?:appointment|breakfast|call|check-?in|dinner|event|interview|lunch|meeting|practice|presentation|reservation|review|session|sync|visit|webinar|workshop)\b/i.test(
      text,
    )
  ) {
    return false;
  }
  return /\b(appointment|breakfast|client call|conference call|dinner|flight|interview|lecture|lunch|meeting|office hours|practice|presentation|reservation|scheduled session|stand-?up|sync|town hall|visit|webinar|workshop)\b/i.test(
    text,
  );
}

function isDeadlineLanguage(text: string): boolean {
  return /\b(by|due|before|submit|complete|finish)\b/i.test(text);
}

function priorityFor(
  text: string,
  dueDate: string | undefined,
  currentLocalDate: string,
): { priority: TaskPriority; confidence: number } {
  if (/\b(?:urgent|asap)\b/i.test(text)) {
    return { priority: "urgent", confidence: 0.95 };
  }

  if (dueDate) {
    const daysUntilDue = differenceInCalendarDays(
      parseISO(dueDate),
      parseISO(currentLocalDate),
    );
    if (daysUntilDue <= 0) {
      return { priority: "urgent", confidence: 0.94 };
    }
    if (daysUntilDue <= 2) {
      return { priority: "high", confidence: 0.9 };
    }
  }

  if (/\b(?:important|high priority)\b/i.test(text)) {
    return { priority: "high", confidence: 0.92 };
  }
  return { priority: "medium", confidence: dueDate ? 0.74 : 0.55 };
}

function hasActionVerb(text: string): boolean {
  return (
    /\b(?:apply|approve|attend|book|bring|build|buy|call|cancel|choose|clean|complete|confirm|create|deliver|do|draft|email|exercise|finish|fix|go|make|meet|pay|pick\s+up|practice|prepare|read|register|remember\s+to|renew|reply|request|respond|return|review|rsvp|run|schedule|select|send|sign|study|submit|take|turn\s+in|update|upload|view|waive|wash|write)\b/i.test(
      text,
    ) ||
    /\b(?:need(?:s)?|want(?:s)?|should|must|have|has|gotta|plan(?:s)?|hope(?:s)?|would like|i[’']d like|get around)\b.{0,60}\b(?:applying|approving|attending|booking|bringing|building|buying|calling|cancel(?:l)?ing|choosing|cleaning|completing|confirming|creating|delivering|drafting|emailing|exercising|finishing|fixing|making|paying|practicing|preparing|reading|registering|remembering|renewing|replying|requesting|responding|returning|reviewing|running|scheduling|sending|signing|studying|submitting|taking|updating|uploading|washing|writing)\b/i.test(
      text,
    )
  );
}

function hasTaskNoun(text: string): boolean {
  return /\b(?:appointment|application|approval|assignment|bill|birthday|deadline|dentist|dishes|doctor|errand|essay|exam|flight|form|groceries|gym|homework|interview|invoice|laundry|medication|meeting|payment|project|quiz|rent|report|reservation|response|signature|taxes|test|therapy|workout)\b/i.test(
    text,
  );
}

function isClearlyNonTask(text: string): boolean {
  const trimmed = text.trim();
  return (
    !trimmed ||
    /^(?:>|☑|✅|✔|\[[xX]\])/u.test(trimmed) ||
    /^on\s+.+\s+wrote\s*:\s*$/i.test(trimmed) ||
    /\b(?:do not|don't|no need to|not required to|ignore|disregard)\b/i.test(
      trimmed,
    ) ||
    /\b(?:already|previously|just)\s+(?:approved|booked|completed|confirmed|finished|paid|replied|responded|reviewed|sent|signed|submitted|uploaded)\b/i.test(
      trimmed,
    ) ||
    /\b(?:has been|was|is)\s+(?:cancelled|canceled|completed|done|finished|submitted)\b/i.test(
      trimmed,
    ) ||
    /^(?:confidentiality notice|this (?:email|message) (?:and|may)|unsubscribe\b)/i.test(
      trimmed,
    ) ||
    /^(?:task|action|item)\s+(?:due|deadline|estimate|duration|owner)(?:\s+(?:due|deadline|estimate|duration|owner))*$/i.test(
      trimmed,
    ) ||
    /^(?:tasks?\s+)?due\s+in\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)$/i.test(
      trimmed,
    ) ||
    /^(?:from|to|cc|bcc|subject|sent)\s*:/i.test(trimmed) ||
    /^(?:hi|hello|hey|thanks|thank you|best|regards|sincerely)[\s,!.-]*(?:\w+)?$/i.test(
      trimmed,
    ) ||
    /^(?:https?:\/\/|www\.)\S+$/i.test(trimmed) ||
    (!hasActionVerb(trimmed) &&
      /\b(?:available|cancelled|canceled|closed|delayed|located|moved|open|rescheduled)\b/i.test(
        trimmed,
      ))
  );
}

function isTaskCandidate(text: string, datePhrase?: string): boolean {
  if (isClearlyNonTask(text)) return false;
  const title = titleFor(text, datePhrase);
  if (!title || title.toLocaleLowerCase() === datePhrase?.toLocaleLowerCase()) {
    return false;
  }
  const action = hasActionVerb(text);
  if (
    /^(?:fyi|note|reminder|information|background)\s*:/i.test(text) &&
    !action
  ) {
    return false;
  }
  const titleWords = title.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  return (
    action ||
    hasTaskNoun(text) ||
    isFixedEvent(text) ||
    isDeadlineLanguage(text) ||
    Boolean(parseTimedRecurrence(text)) ||
    Boolean(recurrenceCount(text)) ||
    Boolean(datePhrase && titleWords.length >= 2)
  );
}

function ignoredReason(text: string): string {
  if (/^(?:fyi|note|reminder|information|background)\s*:/i.test(text)) {
    return "Informational reminder with no concrete user action.";
  }
  if (isClearlyNonTask(text)) {
    return "Metadata, greeting, link, or status update; no task was created.";
  }
  return "No concrete task or scheduled responsibility was identified.";
}

function buildTask(
  line: string,
  datePhrase: string | undefined,
  interpreted: InterpretedDate | undefined,
  input: ExtractionInput,
  index: number,
  timedRecurrence?: ParsedTimedRecurrence,
  agendaTiming?: { fixed: true; fixedEndAt?: string },
): ExtractedTask {
  const estimate = estimateMinutes(line);
  const count = recurrenceCount(line);
  const alternatingDays =
    /\b(?:every\s+(?:other|second|2(?:nd)?)\s+day|on\s+alternate\s+days?|alternat(?:e|ing)\b.{0,40}\bdays?|day\s+on[\s,/-]+day\s+off)\b/i.test(
      line,
    );
  const fixed =
    agendaTiming?.fixed ||
    (!timedRecurrence && isFixedEvent(line) && !isDeadlineLanguage(line));
  const taskType =
    timedRecurrence || count
      ? "recurring_goal"
      : fixed
        ? "fixed_time"
        : "flexible";
  const category = categoryFor(line);
  const priority = priorityFor(
    line,
    !fixed ? interpreted?.date : undefined,
    input.currentLocalDate,
  );
  const fixedStartAt = fixed ? interpreted?.instant : undefined;
  const fixedEndAt = agendaTiming?.fixedEndAt ??
    (fixedStartAt && (agendaTiming?.fixed || /\bfor\s+\d+/i.test(line))
      ? addHours(new Date(fixedStartAt), estimate.minutes / 60).toISOString()
      : undefined);
  const missingInformation: string[] = [];
  if (estimate.assumed) missingInformation.push("Confirm effort estimate");
  if (!interpreted?.date && !count && !fixed && !timedRecurrence) {
    missingInformation.push("No deadline was stated");
  }
  if (fixed && !fixedEndAt) missingInformation.push("Fixed event end time");
  if (interpreted?.ambiguous) missingInformation.push("Clarify date or time");
  if (timedRecurrence?.issues.length) {
    missingInformation.push(...timedRecurrence.issues);
  }
  const reviewRequired =
    (fixed && (!fixedStartAt || !fixedEndAt)) ||
    Boolean(interpreted?.ambiguous) ||
    Boolean(timedRecurrence?.issues.length) ||
    estimate.confidence < 0.5;
  const week = count
    ? localWeekWindow(input.currentLocalDate, input.timeZone, line)
    : undefined;

  return {
    id: `imported-${index + 1}`,
    title: titleFor(timedRecurrence?.titleSource ?? line, datePhrase),
    taskType,
    dueDate: !fixed ? interpreted?.date : undefined,
    dueTime: !fixed ? interpreted?.time : undefined,
    dueAt: !fixed ? interpreted?.instant : undefined,
    fixedStartAt,
    fixedEndAt,
    estimatedMinutes: estimate.minutes,
    effortEstimateSource: estimate.source,
    effortEstimateRationale: estimate.rationale,
    priority: priority.priority,
    category,
    energyDemand:
      category === "school" || category === "work"
        ? "high"
        : category === "errand"
          ? "low"
          : "medium",
    splittable:
      /\bsplit|over several|across\b/i.test(line) ||
      (estimate.minutes > 60 && !fixed && !count),
    minimumSessionMinutes: count ? estimate.minutes : Math.min(30, estimate.minutes),
    recurrence: timedRecurrence?.recurrence ??
      (count
        ? {
          frequency: alternatingDays ? "daily" : "weekly",
          mode: "quota",
          interval: alternatingDays ? 2 : undefined,
          count,
          windowStart: week?.start,
          windowEnd: week?.end,
        }
        : undefined),
    confidence: reviewRequired ? 0.62 : 0.9,
    fieldConfidence: {
      title: 0.94,
      taskType: fixed || count || timedRecurrence ? 0.96 : 0.84,
      dueDate: interpreted?.date ? 0.92 : undefined,
      dueTime: interpreted?.time ? 0.92 : undefined,
      estimatedMinutes: estimate.confidence,
      priority: priority.confidence,
      recurrence: count || timedRecurrence ? 0.98 : undefined,
    },
    missingInformation,
    sourceText: line,
    approved: !reviewRequired,
    reviewRequired,
  };
}

export class MockTaskExtractionProvider implements TaskExtractionProvider {
  async extractTasks(input: ExtractionInput): Promise<ExtractionResult> {
    const fragments = sourceFragments(input.text);
    const lines = fragments.reduce<string[]>((items, fragment) => {
      if (
        /^(?:(?:about|roughly|approximately)\s+\d+|(?:due|deadline|when|time|estimate|duration|effort)\s*:|(?:(?:it|this|that)\s+)?(?:should|will|would|could|might|may|probably|roughly|likely|only)+\s*(?:take|takes|need|needs|require|requires|run)\b|(?:it|this|that)\s+(?:take|takes|need|needs|require|requires|run)\b)/i.test(
          fragment,
        ) &&
        items.length > 0
      ) {
        items[items.length - 1] = `${items[items.length - 1]} ${fragment}`;
      } else {
        items.push(fragment);
      }
      return items;
    }, []);
    const tasks: ExtractedTask[] = [];
    const agendaTaskIds = new Set<string>();
    const agendaOnwardTaskIds = new Set<string>();
    const ignoredStatements: ExtractionResult["ignoredStatements"] = [];
    let agendaDateContext: string | undefined;
    const agendaBlockedTimes: NonNullable<
      ExtractionResult["planningRules"]
    >["blockedTimes"] = [];

    lines.forEach((line, index) => {
      const baseSemanticLine = semanticText(line);
      const dayHeading = dayAgendaDateContext(baseSemanticLine);
      if (dayHeading) {
        agendaDateContext = dayHeading;
        ignoredStatements.push({
          sourceText: line,
          reason: "Weekday heading used as context for the entries below.",
        });
        return;
      }
      const agendaHeading =
        /^(?:schedule|agenda|calendar|appointments?|events?)\s*(?:for|on)?\s*[:—–-]?\s*(.+)$/i.exec(
          baseSemanticLine,
        );
      const headingDate = agendaHeading
        ? extractDatePhrase(agendaHeading[1])
        : undefined;
      if (headingDate) {
        agendaDateContext = headingDate;
        ignoredStatements.push({
          sourceText: line,
          reason: "Schedule heading used as context for the entries below.",
        });
        return;
      }
      const protectedTime = agendaDateContext
        ? /^after\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s*(?:[-–—:]\s*)?(?:keep(?:\s+.+)?\s+free|free|do not schedule|don't schedule)\s*$/i.exec(
            baseSemanticLine,
          )
        : undefined;
      if (protectedTime) {
        const interpretedStart = resolveRelativeDate(
          `${agendaDateContext} at ${protectedTime[1]}`,
          input.currentLocalDate,
          input.timeZone,
        );
        if (interpretedStart.date && interpretedStart.instant) {
          const nextDate = format(
            addDays(parseISO(interpretedStart.date), 1),
            "yyyy-MM-dd",
          );
          agendaBlockedTimes.push({
            start: interpretedStart.instant,
            end: fromZonedTime(
              `${nextDate}T00:00:00`,
              input.timeZone,
            ).toISOString(),
            label: "Protected free time",
          });
          ignoredStatements.push({
            sourceText: line,
            reason: "Protected free time added as a scheduling rule.",
          });
          return;
        }
      }
      const agendaRange = agendaDateContext
        ? /^(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:-|–|—|to)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:[-–—:]\s*)?(.+)$/i.exec(
            baseSemanticLine,
          )
        : undefined;
      const agendaOnward = agendaDateContext
        ? /^(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s+(?:onward|onwards)\s*(?:[-–—:]\s*)?(.+)$/i.exec(
            baseSemanticLine,
          )
        : undefined;
      const agendaSingle = agendaDateContext
        ? /^(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s*(?:[-–—:]\s*)?(.+)$/i.exec(
            baseSemanticLine,
          )
        : undefined;
      const agendaMinutes = agendaRange
        ? agendaRangeMinutes(agendaRange[1], agendaRange[2])
        : undefined;
      const semanticLine = agendaRange
        ? `${agendaRange[3]} ${agendaDateContext} at ${agendaRange[1]}${agendaMinutes ? ` for ${agendaMinutes} minutes` : ""}`
        : agendaOnward
          ? `${agendaOnward[2]} ${agendaDateContext} at ${agendaOnward[1]}`
        : agendaSingle
          ? `${agendaSingle[2]} ${agendaDateContext} at ${agendaSingle[1]}`
          : baseSemanticLine;
      const agendaFixed = Boolean(agendaRange || agendaOnward || agendaSingle);
      const alternatingWithoutClock =
        /\b(?:every\s+(?:other|second|2(?:nd)?)\s+day|on\s+alternate\s+days?|alternat(?:e|ing)\b.{0,40}\bdays?|day\s+on[\s,/-]+day\s+off)\b/i.test(
          semanticLine,
        ) &&
        !/\b(?:[01]?\d|2[0-3]):[0-5]\d\s*(?:am|pm)?\b|\b(?:1[0-2]|0?[1-9])\s*(?:am|pm)\b/i.test(
          semanticLine,
        );
      const timedRecurrence = alternatingWithoutClock
        ? undefined
        : parseTimedRecurrence(semanticLine, {
            currentLocalDate: input.currentLocalDate,
            timeZone: input.timeZone,
          });
      const datePhrase = timedRecurrence
        ? undefined
        : extractDatePhrase(semanticLine);
      if (!isTaskCandidate(semanticLine, datePhrase)) {
        ignoredStatements.push({
          sourceText: line,
          reason: ignoredReason(semanticLine),
        });
        return;
      }
      const interpreted = datePhrase
        ? resolveRelativeDate(
            datePhrase,
            input.currentLocalDate,
            input.timeZone,
          )
        : undefined;
      const agendaFixedEndAt = agendaOnward && interpreted?.date
        ? fromZonedTime(
            `${format(addDays(parseISO(interpreted.date), 1), "yyyy-MM-dd")}T00:00:00`,
            input.timeZone,
          ).toISOString()
        : undefined;
      if (tasks.length >= 100) {
        if (ignoredStatements.length < 100) {
          ignoredStatements.push({
            sourceText: line,
            reason: "The import reached the 100-responsibility safety limit.",
          });
        }
        return;
      }
      const task = {
        ...buildTask(
          semanticLine,
          datePhrase,
          interpreted,
          input,
          index,
          timedRecurrence,
          agendaFixed
            ? { fixed: true, fixedEndAt: agendaFixedEndAt }
            : undefined,
        ),
        sourceText: line,
      };
      tasks.push(task);
      if (agendaFixed && task.id) agendaTaskIds.add(task.id);
      if (agendaOnward && task.id) agendaOnwardTaskIds.add(task.id);
    });

    const agendaBoundaries = [
      ...tasks
        .filter(
          (task) =>
            task.id && agendaTaskIds.has(task.id) && task.fixedStartAt,
        )
        .map((task) => new Date(task.fixedStartAt!).getTime()),
      ...agendaBlockedTimes.map((interval) => new Date(interval.start).getTime()),
    ];
    const normalizedTasks = tasks.map((task) => {
      if (
        !task.id ||
        !agendaTaskIds.has(task.id) ||
        !task.fixedStartAt ||
        !task.fixedEndAt
      ) {
        return task;
      }
      const start = new Date(task.fixedStartAt).getTime();
      const originalEnd = new Date(task.fixedEndAt).getTime();
      const nextBoundary = Math.min(
        originalEnd,
        ...agendaBoundaries.filter((value) => value > start),
      );
      const minutes = Math.round((nextBoundary - start) / 60_000);
      if (minutes <= 0) return task;
      const onward = agendaOnwardTaskIds.has(task.id);
      const clamped = nextBoundary < originalEnd;
      if (!onward && !clamped) return task;
      const missingInformation = onward
        ? task.missingInformation.filter(
            (item) => !/confirm effort estimate/i.test(item),
          )
        : task.missingInformation;
      return {
        ...task,
        fixedEndAt: new Date(nextBoundary).toISOString(),
        estimatedMinutes: minutes,
        minimumSessionMinutes: Math.min(
          task.minimumSessionMinutes ?? minutes,
          minutes,
        ),
        effortEstimateSource: onward ? "stated" as const : task.effortEstimateSource,
        effortEstimateRationale: onward
          ? "Used “onward” to reserve the rest of that day."
          : "Capped the local duration estimate at the next fixed agenda entry.",
        fieldConfidence: onward
          ? { ...task.fieldConfidence, estimatedMinutes: 0.98 }
          : task.fieldConfidence,
        missingInformation,
        reviewRequired: onward ? false : task.reviewRequired,
        approved: onward ? true : task.approved,
      };
    });

    return validateAndDedupeExtraction({
      tasks: normalizedTasks,
      ignoredStatements: ignoredStatements.slice(0, 100),
      planningRules: agendaBlockedTimes.length
        ? { blockedTimes: agendaBlockedTimes }
        : undefined,
    });
  }
}
