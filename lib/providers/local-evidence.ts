import type { ExtractionInput } from "@/lib/domain/types";

const MAX_SCANNED_CHARACTERS = 40_000;
const MAX_BOUNDARIES = 64;
const MAX_MATCHES_PER_CLASS = 40;
const MAX_BOUNDARY_QUOTE_LENGTH = 480;

export type SourceSpan = {
  start: number;
  end: number;
  quote: string;
};

export type LocalBoundaryEvidence = SourceSpan & {
  boundary: "sentence" | "line" | "list_item";
  truncated: boolean;
};

export type LocalLexicalEvidence = SourceSpan & {
  lexicalClass:
    | "date_or_time_phrase"
    | "duration_phrase"
    | "ordering_phrase"
    | "soft_language_phrase"
    | "correction_phrase"
    | "negation_or_uncertainty_phrase";
};

/**
 * Mechanical source observations supplied to a semantic extractor. These
 * observations deliberately do not decide what is a task, event, deadline,
 * dependency, constraint, or preference.
 */
export type LocalEvidenceHint = {
  policy: "lexical_source_evidence_only";
  sourceLength: number;
  scannedCharacters: number;
  sourceTruncated: boolean;
  limitsReached: boolean;
  boundaries: LocalBoundaryEvidence[];
  phrases: LocalLexicalEvidence[];
};

type PhrasePattern = {
  lexicalClass: LocalLexicalEvidence["lexicalClass"];
  patterns: RegExp[];
};

const MONTH =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WEEKDAY =
  "(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)";
const DAY_PERIOD =
  "(?:early\\s+)?(?:morning|afternoon|evening)|(?:late\\s+)?night|noon|midnight";
const NUMBER_WORD =
  "(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty(?:-five)?|sixty|ninety|half|quarter)";

const PHRASE_PATTERNS: PhrasePattern[] = [
  {
    lexicalClass: "date_or_time_phrase",
    patterns: [
      new RegExp(
        `\\b(?:this|next|last)?\\s*${WEEKDAY}(?:\\s*,?\\s*(?:${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:\\s*,?\\s*\\d{2,4})?|${DAY_PERIOD}))?\\b`,
        "gi",
      ),
      new RegExp(
        `\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:\\s*,?\\s*\\d{2,4})?(?:\\s+(?:at|by)\\s+\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?))?\\b`,
        "gi",
      ),
      /\b\d{4}-\d{1,2}-\d{1,2}\b/g,
      /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g,
      new RegExp(
        `\\b(?:today|tomorrow|tonight|the day after tomorrow|this weekend|next week|end of (?:the )?(?:day|week|month))(?:\\s+${DAY_PERIOD})?\\b`,
        "gi",
      ),
      new RegExp(`\\b${DAY_PERIOD}\\b`, "gi"),
      /\b(?:from\s+)?\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?\s*(?:-|–|—|to|through|until)\s*\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/gi,
      /\b(?:at|by|around|before|after)\s+\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/gi,
      /\b\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)\b/gi,
    ],
  },
  {
    lexicalClass: "duration_phrase",
    patterns: [
      /\b(?:for\s+)?(?:about|around|roughly|approximately|nearly|up to|at least)?\s*(?:a|an)\s+(?:half\s+)?(?:hour|hr)\b/gi,
      /\b(?:for\s+)?(?:about|around|roughly|approximately|nearly|up to|at least)?\s*(?:half an hour|half-hour|quarter of an hour)\b/gi,
      new RegExp(
        `\\b(?:for\\s+)?(?:about|around|roughly|approximately|between|from)?\\s*(?:\\d+(?:\\.\\d+)?|${NUMBER_WORD})(?:(?:\\s+(?:and|to|or)\\s+|\\s*[-–—]\\s*)(?:\\d+(?:\\.\\d+)?|${NUMBER_WORD}))?\\s*(?:minutes?|mins?|hours?|hrs?|days?|weeks?)\\b`,
        "gi",
      ),
    ],
  },
  {
    lexicalClass: "ordering_phrase",
    patterns: [
      /\b(?:only\s+after|not\s+until|as\s+soon\s+as|prior\s+to|beforehand|before|after|once|following|subsequently|then|first|next|finally|depends?\s+on|contingent\s+on|in\s+advance\s+of)\b/gi,
    ],
  },
  {
    lexicalClass: "soft_language_phrase",
    patterns: [
      /\b(?:if\s+possible|if\s+you\s+can|ideally|preferably|prefer(?:red)?|would\s+rather|when(?:ever)?\s+convenient|try\s+to|aim\s+to|hopefully|nice\s+to\s+have)\b/gi,
    ],
  },
  {
    lexicalClass: "correction_phrase",
    patterns: [
      /\b(?:actually|correction|instead|rather\s+than|disregard(?:\s+that|\s+the\s+previous)?|ignore\s+(?:that|the\s+previous)|scratch\s+that|make\s+that|I\s+meant|no\s+longer|revised|revision|updated|supersed(?:e|ed|es)|change(?:d)?\s+(?:it|that)\s+to)\b/gi,
    ],
  },
  {
    lexicalClass: "negation_or_uncertainty_phrase",
    patterns: [
      /\b(?:do\s+not|don['’]t|does\s+not|doesn['’]t|no\s+need\s+to|not\s+required|already|completed|cancelled|canceled|maybe|perhaps|possibly|probably|might|may|unsure|uncertain|tentative(?:ly)?|not\s+sure|approximately|roughly|around|about)\b/gi,
    ],
  },
];

function trimSpan(text: string, start: number, end: number): SourceSpan | undefined {
  while (start < end && /\s/.test(text[start])) start += 1;
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  if (end <= start) return undefined;
  return { start, end, quote: text.slice(start, end) };
}

function boundaryEvidence(
  text: string,
  start: number,
  end: number,
  boundary: LocalBoundaryEvidence["boundary"],
): LocalBoundaryEvidence | undefined {
  const span = trimSpan(text, start, end);
  if (!span) return undefined;
  const clippedEnd = Math.min(span.end, span.start + MAX_BOUNDARY_QUOTE_LENGTH);
  return {
    start: span.start,
    end: clippedEnd,
    quote: text.slice(span.start, clippedEnd),
    boundary,
    truncated: clippedEnd < span.end,
  };
}

function collectBoundaries(text: string): {
  values: LocalBoundaryEvidence[];
  capped: boolean;
} {
  const values: LocalBoundaryEvidence[] = [];
  const linePattern = /[^\r\n]+/g;
  let lineMatch: RegExpExecArray | null;

  while ((lineMatch = linePattern.exec(text))) {
    const line = lineMatch[0];
    const lineStart = lineMatch.index;
    const trimmed = line.trimStart();
    const leading = line.length - trimmed.length;
    const isListItem = /^(?:[-*•]\s+|\d+[.)]\s+|\[[ xX]\]\s+)/.test(trimmed);

    if (isListItem) {
      const value = boundaryEvidence(
        text,
        lineStart + leading,
        lineStart + line.length,
        "list_item",
      );
      if (value) values.push(value);
    } else {
      const sentencePattern = /[^.!?]+(?:[.!?]+(?=\s|$)|$)/g;
      const sentenceMatches = [...line.matchAll(sentencePattern)].filter((match) =>
        Boolean(match[0].trim()),
      );
      for (const sentence of sentenceMatches) {
        const value = boundaryEvidence(
          text,
          lineStart + (sentence.index ?? 0),
          lineStart + (sentence.index ?? 0) + sentence[0].length,
          sentenceMatches.length === 1 && !/[.!?]\s*$/.test(line)
            ? "line"
            : "sentence",
        );
        if (value) values.push(value);
        if (values.length >= MAX_BOUNDARIES) {
          return { values, capped: true };
        }
      }
    }

    if (values.length >= MAX_BOUNDARIES) return { values, capped: true };
  }

  return { values, capped: false };
}

function collectPhrases(text: string): {
  values: LocalLexicalEvidence[];
  capped: boolean;
} {
  const values: LocalLexicalEvidence[] = [];
  let capped = false;

  for (const group of PHRASE_PATTERNS) {
    const candidates: LocalLexicalEvidence[] = [];
    for (const pattern of group.patterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text))) {
        const span = trimSpan(text, match.index, match.index + match[0].length);
        if (span) candidates.push({ ...span, lexicalClass: group.lexicalClass });
        if (match[0].length === 0) pattern.lastIndex += 1;
      }
    }

    candidates.sort((left, right) =>
      left.start === right.start
        ? right.end - right.start - (left.end - left.start)
        : left.start - right.start,
    );

    const selected: LocalLexicalEvidence[] = [];
    for (const candidate of candidates) {
      if (
        selected.some(
          (existing) =>
            candidate.start >= existing.start && candidate.end <= existing.end,
        )
      ) {
        continue;
      }
      if (selected.length >= MAX_MATCHES_PER_CLASS) {
        capped = true;
        break;
      }
      selected.push(candidate);
    }
    values.push(...selected);
  }

  values.sort((left, right) =>
    left.start === right.start
      ? left.lexicalClass.localeCompare(right.lexicalClass)
      : left.start - right.start,
  );
  return { values, capped };
}

export function buildLocalEvidenceHint(input: ExtractionInput): LocalEvidenceHint {
  const scannedCharacters = Math.min(input.text.length, MAX_SCANNED_CHARACTERS);
  const scannedText = input.text.slice(0, scannedCharacters);
  const boundaries = collectBoundaries(scannedText);
  const phrases = collectPhrases(scannedText);

  return {
    policy: "lexical_source_evidence_only",
    sourceLength: input.text.length,
    scannedCharacters,
    sourceTruncated: scannedCharacters < input.text.length,
    limitsReached: boundaries.capped || phrases.capped,
    boundaries: boundaries.values,
    phrases: phrases.values,
  };
}

export function formatLocalEvidenceHint(input: ExtractionInput): string {
  return JSON.stringify(buildLocalEvidenceHint(input));
}
