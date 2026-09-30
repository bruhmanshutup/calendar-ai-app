import type { ExtractionInput } from "@/lib/domain/types";
import { prepareStructuredPlanExtractionInput } from "./structured-plan-recovery";

export type NarrativeStructureRole =
  | "action"
  | "dependent_action"
  | "possible_multiple_actions"
  | "detail"
  | "global_schedule_rule"
  | "list_item"
  | "completed_item"
  | "email_subject"
  | "email_metadata"
  | "heading_or_context";

export type NarrativeStructureSegment = {
  paragraph: number;
  line: number;
  sentence: number;
  role: NarrativeStructureRole;
  text: string;
};

const MAX_STRUCTURE_SEGMENTS = 180;
const MAX_STRUCTURE_HINT_CHARS = 8_000;

const BULLET_PREFIX =
  /^\s*(?:[-*\u2022\u2023\u25aa\u25ab\u25e6\u2013\u2014]\s+|\d{1,3}[.)]\s+|[a-z][.)]\s+|\[[ xX]\]\s+|[\u2610\u2611\u2713\u2714]\s*)/iu;
const COMPLETED_PREFIX =
  /^\s*(?:\[[xX]\]|[\u2611\u2713\u2714])\s*|\b(?:done|completed|cancelled|canceled|not needed)\b/i;
const EMAIL_METADATA = /^(?:from|to|cc|bcc|sent|date|reply-to):\s*/i;
const EMAIL_SUBJECT = /^subject:\s*/i;
const GREETING_OR_SIGNATURE =
  /^(?:hi|hello|hey|dear)\b[^.!?]{0,80}[,:]?\s*$|^(?:thanks|thank you|best|regards|sincerely|cheers)[,!]?\s*$/i;
const DEPENDENCY_START =
  /^(?:before (?:then|that|this|the meeting|the appointment)|beforehand|prior to (?:that|this|the meeting|the appointment)|after (?:that|this|the meeting|the appointment)|afterward|afterwards|once (?:that|this|it)\b|first,?\s|then,?\s)/i;
const GLOBAL_RULE =
  /\b(?:keep|leave|block)\b[^.!?]{0,60}\b(?:free|open|unscheduled)\b|\b(?:do not|don['\u2019]t|dont)\s+schedule\s+(?:anything|work)\b|\b(?:usually\s+)?(?:wake up|get up|go to (?:sleep|bed))\b|\b(?:work|tasks?)\s+scheduled\s+(?:before|after)\b|\b(?:unavailable|not available)\b/i;
const DETAIL_START =
  /^(?:it(?:['\u2019]s|['\u2019]ll| is| will| should| would| can| takes?)?\b|they(?:['\u2019]re| are| can| only)?\b|(?:this|that|these|those)\s+(?:is|are|should|would|will|can|takes?)\b|each\b|the\s+(?:call|task|work|appointment|office|store|place|session|workout|assignment|project)\b|takes?\b|should\s+(?:only\s+)?take\b|probably\s+(?:takes?|will take)\b|estimated\b|about\b|around\b|roughly\b|approximately\b|maybe\b|no\s+(?:real\s+)?deadline\b|there(?:['\u2019]s| is)\s+no\s+deadline\b|(?:i\s+)?(?:also\s+)?prefer\b|i(?:['\u2019]d| would)\s+rather\b|if possible\b|when(?:ever)?\b|(?:it\s+)?doesn['\u2019]?t\s+(?:really\s+)?matter\b|not urgent\b|(?:this|it)\s+is\s+(?:pretty\s+)?important\b|school stuff\b|(?:break|split)\s+(?:that|this|it|the work)\b|try to give me\b)/i;
const FIRST_PERSON_ACTION =
  /^(?:(?:also|and|but)\s+)?(?:(?:(?:i|we)\s+)?(?:also\s+)?(?:need(?:ed)?\s+to|have\s+to|must|should|want\s+to|would\s+like\s+to|plan\s+to|hope\s+to|ought\s+to|gotta|need)\b|i(?:['\u2019]d| would)\s+like\s+to\b|i(?:['\u2019]m| am)\s+supposed\s+to\b|i(?:['\u2019]ve| have)\s+got\s+to\b|i\s+can(?:not|['\u2019]t)\s+forget\s+to\b)/i;
const REQUEST_ACTION =
  /^(?:please\s+)?(?:can|could|would)\s+you\b|^(?:please\s+)?(?:add a reminder to|make sure to|remind me (?:to|about)|remember to|don['\u2019]t forget to)\b/i;
const IMPERATIVE_ACTION =
  /^(?:please\s+)?(?:add|apply|attend|book|buy|call|cancel|check|clean|complete|confirm|contact|do|draft|drop off|email|exercise|file|fill|finish|follow up|get|go|make|meet|order|organize|pay|pick up|practice|prepare|print|proofread|read|register|renew|reply|request|research|respond|return|review|rsvp|scan|schedule|send|shop|sign|start|study|submit|take|update|upload|view|visit|wash|work on|write)\b/i;
const EVENT_STATEMENT =
  /^(?:(?:just\s+)?a\s+reminder\s+that\s+)?(?:(?:i\s+have|there(?:['\u2019]s| is)|my)\b[^.!?]{0,90}\b(?:appointment|class|exam|interview|meeting|quiz|shift|flight|reservation|deadline|due)\b|(?:your|our|the|this|that|a|an)\b[^.!?]{0,100}\b(?:is|are)\s+due\b)/i;
const MEETING_STATEMENT =
  /^(?:we|i|you|they)(?:['\u2019]ll|\s+will)?\s+meet\b/i;
const CONDITIONAL_ACTION_START =
  /^if\s+possible,?\s+(?:please\s+)?(?:try\s+to\s+)?/i;
const ACTIVE_COMMITMENT =
  /^(?:(?:on\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tonight|tomorrow)\s*,?\s+)?i(?:['\u2019]m| am)\s+(?:attending|driving|flying|hanging out|having|meeting|seeing|traveling|volunteering|working)\b/i;
const IMPLIED_ACTIVITY =
  /^(?:cleaning|calling|checking|emailing|finishing|ordering|preparing|reading|reviewing|shopping|studying|submitting|writing|working on)\b[^.!?]{0,80}\b(?:takes?|should take|will take|needs? to be done|is due)\b/i;
const ACTION_VERB =
  "add|apply|attend|book|buy|call|cancel|check|clean|complete|confirm|contact|draft|email|exercise|file|fill|finish|follow up|go|make|meet|order|organize|pay|pick up|prepare|read|register|renew|reply|request|research|respond|review|schedule|send|shop|sign|start|study|submit|update|upload|view|visit|work on|write";
const SECOND_ACTION = new RegExp(
  `\\b(?:and|but|so|then)\\s+(?:(?:i|we)\\s+)?(?:also\\s+)?(?:(?:need|have|want|should|must|plan)\\s+to\\s+|${ACTION_VERB}\\b)`,
  "i",
);
const HEADING = /^(?:.{1,60}:|(?:tasks?|agenda|schedule|reminders?|this week|today|tomorrow))$/i;

function isActionStatement(text: string): boolean {
  return (
    FIRST_PERSON_ACTION.test(text) ||
    REQUEST_ACTION.test(text) ||
    IMPERATIVE_ACTION.test(text) ||
    EVENT_STATEMENT.test(text) ||
    MEETING_STATEMENT.test(text) ||
    ACTIVE_COMMITMENT.test(text) ||
    IMPLIED_ACTIVITY.test(text)
  );
}

function splitSentences(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  const protectedLine = trimmed
    .replace(
      /\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|vs|etc)\./gi,
      "$1\uE000",
    )
    .replace(/\b([ei])\.g\./gi, "$1\uE000g\uE000");
  try {
    return Array.from(
      new Intl.Segmenter("en", { granularity: "sentence" }).segment(
        protectedLine,
      ),
      ({ segment }) => segment.replace(/\uE000/g, ".").trim(),
    ).filter(Boolean);
  } catch {
    return protectedLine
      .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
      .map((segment) => segment.replace(/\uE000/g, "."))
      .filter(Boolean);
  }
}

function classifySegment(
  segment: string,
  listLine: boolean,
  hasEarlierAction: boolean,
): NarrativeStructureRole {
  const text = segment.replace(BULLET_PREFIX, "").trim();
  if (EMAIL_SUBJECT.test(text)) return "email_subject";
  if (EMAIL_METADATA.test(text) || GREETING_OR_SIGNATURE.test(text)) {
    return "email_metadata";
  }
  if (listLine && COMPLETED_PREFIX.test(segment)) return "completed_item";
  const dependencyRemainder = DEPENDENCY_START.test(text)
    ? text.replace(DEPENDENCY_START, "").replace(/^,\s*/, "").trim()
    : undefined;
  if (dependencyRemainder && isActionStatement(dependencyRemainder)) {
    return "dependent_action";
  }
  if (GLOBAL_RULE.test(text)) {
    return ACTIVE_COMMITMENT.test(text) ? "action" : "global_schedule_rule";
  }
  if (SECOND_ACTION.test(text)) return "possible_multiple_actions";
  const conditionalRemainder = CONDITIONAL_ACTION_START.test(text)
    ? text.replace(CONDITIONAL_ACTION_START, "").trim()
    : undefined;
  if (
    conditionalRemainder &&
    !/^(?:do|schedule|make)\s+(?:it|that|this)\b/i.test(conditionalRemainder) &&
    isActionStatement(conditionalRemainder)
  ) {
    return "action";
  }
  if (DETAIL_START.test(text)) return "detail";
  if (isActionStatement(text)) {
    return "action";
  }
  if (listLine) return "list_item";
  if (hasEarlierAction && /^(?:and|but|because|so)\b/i.test(text)) {
    return "detail";
  }
  if (HEADING.test(text) || text.split(/\s+/).length <= 4) {
    return "heading_or_context";
  }
  return "heading_or_context";
}

export function analyzeNarrativeStructure(
  text: string,
): NarrativeStructureSegment[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  const segments: NarrativeStructureSegment[] = [];
  normalized.split(/\n[ \t]*\n+/).some((paragraph, paragraphIndex) => {
    let hasEarlierAction = false;
    paragraph.split("\n").some((line, lineIndex) => {
      if (!line.trim()) return false;
      const listLine = BULLET_PREFIX.test(line);
      splitSentences(line).some((sentence, sentenceIndex) => {
        if (segments.length >= MAX_STRUCTURE_SEGMENTS) return true;
        const role = classifySegment(sentence, listLine, hasEarlierAction);
        segments.push({
          paragraph: paragraphIndex + 1,
          line: lineIndex + 1,
          sentence: sentenceIndex + 1,
          role,
          text: sentence,
        });
        if (
          role === "action" ||
          role === "dependent_action" ||
          role === "possible_multiple_actions" ||
          role === "list_item"
        ) {
          hasEarlierAction = true;
        }
        return false;
      });
      return segments.length >= MAX_STRUCTURE_SEGMENTS;
    });
    return segments.length >= MAX_STRUCTURE_SEGMENTS;
  });
  return segments;
}

/**
 * Builds a small index-only map of the source's paragraph, newline, and sentence
 * structure. It intentionally does not repeat source text, so task source spans
 * remain exact and the AI request grows by only a few characters per segment.
 */
export function buildNarrativeStructureHint(text: string): string | undefined {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return undefined;
  const paragraphs = normalized.split(/\n[ \t]*\n+/);
  const rows: string[] = [];
  const segments = analyzeNarrativeStructure(text);
  const roles = segments.map((segment) => segment.role);
  const segmentCount = segments.length;
  paragraphs.forEach((_, paragraphIndex) => {
    const labels = segments
      .filter((segment) => segment.paragraph === paragraphIndex + 1)
      .map(
        (segment) =>
          `L${segment.line}.S${segment.sentence}=${segment.role}`,
      );
    if (labels.length) rows.push(`P${paragraphIndex + 1}: ${labels.join("; ")}`);
  });

  if (
    segmentCount < 2 &&
    paragraphs.length === 1 &&
    roles[0] !== "possible_multiple_actions" &&
    roles[0] !== "dependent_action" &&
    roles[0] !== "global_schedule_rule"
  ) {
    return undefined;
  }
  const omitted = normalized
    .split(/\n|(?<=[.!?])\s+/)
    .filter((value) => value.trim()).length > segmentCount;
  const header = [
    "Formatting structure map (metadata only; never copy labels into task titles or sourceText):",
    "P = blank-line paragraph (strong boundary); L = physical line (list/row boundary); S = sentence (weak boundary).",
    "action opens a responsibility; detail attaches to the nearest compatible action in that paragraph; dependent_action is separate work linked to prior context; possible_multiple_actions must be checked for more than one responsibility.",
    "A paragraph may contain multiple tasks. A task may also span multiple sentences. Treat the original source as authoritative.",
  ];
  if (omitted) rows.push(`Additional segments omitted after the first ${MAX_STRUCTURE_SEGMENTS}.`);
  const hint = [...header, ...rows].join("\n");
  return hint.length > MAX_STRUCTURE_HINT_CHARS
    ? `${hint.slice(0, MAX_STRUCTURE_HINT_CHARS)}\nStructure map truncated.`
    : hint;
}

export function prepareNarrativeStructureExtractionInput(
  input: ExtractionInput,
): ExtractionInput {
  const structureHint = buildNarrativeStructureHint(input.text);
  return structureHint ? { ...input, structureHint } : input;
}

/** Structured Week/Day plans already have a specialized lossless preparer. */
export function prepareTaskExtractionInput(
  input: ExtractionInput,
): ExtractionInput {
  const structured = prepareStructuredPlanExtractionInput(input);
  return structured.structureHint
    ? structured
    : prepareNarrativeStructureExtractionInput(input);
}
