import type { ExtractionInput, SourceEvidenceSpan } from "@/lib/domain/types";
import type { SemanticDraft } from "./semantic-draft";

type Responsibility = SemanticDraft["responsibilities"][number];
type Relation = SemanticDraft["relations"][number];
export type VerifiedTiming = {
  relation: Relation;
  evidence: SourceEvidenceSpan;
  fromBoundary: "start" | "end";
  toBoundary: "start" | "end";
  mode: "exact" | "latest" | "earliest";
  minutes: number;
  approximate: boolean;
  arrival: boolean;
  travel: boolean;
};

const NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40,
  fortyfive: 45, sixty: 60, ninety: 90, half: 0.5, quarter: 0.25,
};
const NUMBER_ATOM = "(?:\\d+(?:\\.\\d+)?|forty[- ]five|ninety|sixty|forty|thirty|twenty|fifteen|twelve|eleven|ten|nine|eight|seven|six|five|four|three|two|one|half|quarter|an?)";
const NUMBER = `(?:${NUMBER_ATOM}\\s+and\\s+(?:a\\s+)?(?:half|quarter)|${NUMBER_ATOM})`;
const UNIT = "(?:minutes?|mins?|hours?|hrs?|days?|weeks?)";
// Keep two captures (amount, unit phrase) for every consumer. The article in
// “half an hour” belongs to the fraction, and must not be parsed as one hour.
const QUANTITY = `(?<![\\w.])(${NUMBER})\\s*(?:(?:of\\s+)?an?\\s+)?(${UNIT}(?:\\s+and\\s+(?:a\\s+)?(?:half|quarter))?)\\b`;

function quantity(value: string, unit: string): number {
  const number = value.toLowerCase().split(/\s+and\s+(?:a\s+)?/).reduce((total, part) => total + (NUMBERS[part.replace(/[- ]/g, "")] ?? Number(part)), 0)
    + (NUMBERS[/\band\s+(?:a\s+)?(half|quarter)$/i.exec(unit)?.[1]?.toLowerCase() ?? ""] ?? 0);
  return Math.round(number * (/^(?:hour|hr)/i.test(unit) ? 60 : /^day/i.test(unit) ? 1440 : /^week/i.test(unit) ? 10080 : 1));
}

function completeQuantity(source: string, match: RegExpExecArray | RegExpMatchArray, raw?: string): boolean {
  const amount = raw ?? new RegExp(QUANTITY, "i").exec(match[0])?.[0];
  if (!amount || match.index === undefined) return false;
  const start = match.index + match[0].lastIndexOf(amount);
  const prefix = source.slice(0, start).trimEnd().replace(/[-–—]$/, "").trimEnd();
  const previous = /([a-z]+|\d+(?:\.\d+)?)$/i.exec(prefix)?.[1]?.toLowerCase();
  // Unsupported compounds must not yield their last recognizable fragment:
  // “twenty five minutes” is not five; “an hour and 20 minutes” is not 20.
  if (previous && ((!Number.isNaN(Number(previous))) || (previous in NUMBERS && !["a", "an"].includes(previous)) || /^(?:and|hundred|thousand|point)$/.test(previous))) return false;
  const suffix = source.slice(start + amount.length);
  return !new RegExp(`^\\s*(?:and\\s+(?:${NUMBER_ATOM}|a\\s+${NUMBER_ATOM})\\b|${UNIT}\\b)`, "i").test(suffix);
}

function canonical(word: string): string {
  const lower = word.toLowerCase();
  if (/^(?:arriv\w*|arrival|delivery|deliver\w*|lands?|landing)$/.test(lower)) return "arrive";
  if (/^(?:driv\w*|travel\w*|commut\w*|traffic)$/.test(lower)) return "drive";
  if (/^(?:leav\w*|depart\w*|heading)$/.test(lower)) return "drive";
  if (/^(?:finaliz\w*|finish\w*|complet\w*)$/.test(lower)) return "finish";
  if (/^(?:start\w*|begin\w*)$/.test(lower)) return "start";
  if (/^(?:send\w*|submit\w*|submission)$/.test(lower)) return "send";
  return lower.replace(/s$/, "");
}

const GENERIC = new Set("i we you my our the a an to for of on at in with and by task event work session activity attend have need must should do be get it they there then time from before after early ready".split(" "));
function words(text: string): string[] {
  return (text.match(/[a-z]+/gi) ?? []).map(canonical).filter((word) => word.length > 2 && !GENERIC.has(word));
}

function exactSpan(input: ExtractionInput, quote: string): SourceEvidenceSpan | undefined {
  const start = input.text.indexOf(quote);
  return start < 0 ? undefined : {
    ...(input.sourceId ? { sourceId: input.sourceId } : {}),
    start, end: start + quote.length, quote,
  };
}

type Mention = { start: number; end: number };
function mentions(source: string, item: Responsibility, other: Responsibility, hint?: string): Mention[] {
  const otherWords = new Set(words(other.title));
  const identity = new Set(words(item.title).filter((word) => !otherWords.has(word)));
  // A shared noun (two different airport trips, for example) cannot identify
  // an endpoint by itself. Hints must still agree with a distinguishing word.
  if (hint && source.includes(hint) && words(hint).some((word) => identity.has(word))) {
    const start = source.indexOf(hint);
    return [{ start, end: start + hint.length }];
  }
  return [...source.matchAll(/[a-z]+/gi)].flatMap((match) =>
    identity.has(canonical(match[0]))
      ? [{ start: match.index!, end: match.index! + match[0].length }]
      : [],
  );
}

function markPair(source: string, from: Mention, to: Mention): string | undefined {
  if (from.start < to.end && to.start < from.end) return undefined;
  const parts = [
    { ...from, text: " SUBJECT " },
    { ...to, text: " TARGET " },
  ].sort((a, b) => b.start - a.start);
  let marked = source;
  parts.forEach((part) => { marked = marked.slice(0, part.start) + part.text + marked.slice(part.end); });
  return marked;
}

function verifiedCandidate(
  relation: Relation, source: string, from: Responsibility, to: Responsibility,
): Omit<VerifiedTiming, "relation" | "evidence"> | undefined {
  // These cases need semantic judgment or a more specific grammar. Never let
  // an embedded keyword turn negation, alternatives, or uncertainty into fact.
  if (/\b(?:ignore|cancel\w*|instead|unless|might|maybe|probably|not|never|don['’]t|can['’]t)\b/i.test(source)) return undefined;
  const fromMentions = mentions(source, from, to, relation.fromText);
  const toMentions = mentions(source, to, from, relation.toText);
  if (!fromMentions.length || !toMentions.length) return undefined;
  const arrival = /\barriv\w*\b/i.test(from.title) && !/\b(?:drive|driving|travel)\b/i.test(from.title);
  const travel = /\b(?:driv\w*|travel\w*|commut\w*)\b/i.test(from.title);
  const results: Array<Omit<VerifiedTiming, "relation" | "evidence">> = [];
  for (const f of fromMentions) for (const t of toMentions) {
    const marked = markPair(source, f, t);
    if (!marked) continue;
    const base = { approximate: false, arrival: false, travel: false };

    // A single adjacent event supplies the referent for “arrive N early”.
    // General pronoun resolution is deliberately outside this grammar.
    const early = new RegExp(`SUBJECT[^.!?;\\n]{0,65}?(${QUANTITY})\\s+(early|earlier|before|ahead of)\\b`, "i").exec(marked);
    if (arrival && early && relation.relation === "before") {
      if (!completeQuantity(marked, early, early[1])) continue;
      const earlyEnd = early.index + early[0].length;
      const targetInClause = marked.slice(earlyEnd).match(/^[^.!?;\n]{0,70}TARGET/);
      const adjacentTarget = /TARGET[^!?;\n]*[.]\s*[^.!?;\n]*SUBJECT/i.test(marked)
        && (source.match(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi)?.length ?? 0) <= 1;
      if (targetInClause || (adjacentTarget && /early|earlier/i.test(early[4]))) {
        results.push({ ...base, arrival: true, fromBoundary: "start", toBoundary: "start", mode: /\bat least\b/i.test(early[0]) ? "latest" : "exact", minutes: quantity(early[2], early[3]), approximate: /\babout|around|roughly\b/i.test(early[0]) });
        continue;
      }
    }

    // Driving to the stated destination ends at the arrival checkpoint. This
    // special case never treats an arbitrary “before” relationship as equality.
    if (travel && relation.relation === "before" && /\barriv\w*\b/i.test(to.title)
      && /\b(?:drive|driving|travel|commute)\b/i.test(source)
      && /\b(?:there|to|arrive|arrival)\b/i.test(source)
      && !/\b(?:home|back|return|another|different|stop|detour)\b/i.test(source)
      && source.split(/[.!?]\s+/).length <= 4) {
      results.push({ ...base, travel: true, fromBoundary: "end", toBoundary: "start", mode: "exact", minutes: 0 });
      continue;
    }

    const sameSentence = marked.slice(Math.min(marked.indexOf("SUBJECT"), marked.indexOf("TARGET")), Math.max(marked.indexOf("SUBJECT"), marked.indexOf("TARGET")));
    if (/[.!?;\n]/.test(sameSentence)) continue;
    const before = /SUBJECT[^.!?;\n]*?\b(?:before|prior to|ahead of)\b[^,.!?;\n]*?TARGET/i.exec(marked);
    const after = /SUBJECT[^.!?;\n]*?\b(?:after|once|following)\b[^,.!?;\n]*?TARGET/i.exec(marked);
    const inverseBefore = /TARGET[^.!?;\n]*?\bbefore\b[^,.!?;\n]*?SUBJECT/i.exec(marked);
    const inverseAfter = /TARGET[^.!?;\n]*?\b(?:after|once)\b[^,.!?;\n]*?SUBJECT/i.exec(marked);
    const prefixBefore = /\bbefore\s+(?:(?:the|i|we)\s+)?TARGET[^.!?;\n]*?,[^.!?;\n]*?SUBJECT/i.exec(marked);
    const prefixAfter = /\b(?:after|once|when)\s+(?:the\s+)?TARGET[^.!?;\n]*?,[^.!?;\n]*?SUBJECT/i.exec(marked);
    const between = new RegExp(`(?:leave|allow|wait)\\s+${QUANTITY}\\s+after\\s+TARGET\\s+before\\s+SUBJECT`, "i").exec(marked);
    if (between && !completeQuantity(marked, between)) continue;
    const direction = between ? "after" : before || inverseAfter || prefixBefore ? "before" : after || inverseBefore || prefixAfter ? "after" : undefined;
    if (direction !== relation.relation) continue;
    let minutes = between ? quantity(between[1], between[2]) : 0;
    const offset = new RegExp(`${QUANTITY}\\s+(?:before|after|prior to|ahead of)\\b`, "i").exec(marked);
    if (offset && !completeQuantity(marked, offset)) continue;
    if (offset && !/\b(?:for|takes?|lasts?|requires?)\s*$/i.test(marked.slice(0, offset.index))) {
      minutes = quantity(offset[1], offset[2]);
    }
    const startAction = /\b(?:start\w*|begin\w*|leave|depart\w*|arriv\w*)\b/i.test(from.title)
      || /SUBJECT\s+(?:starts?|begins?|leaves?|departs?)|\b(?:start|begin)\s+SUBJECT/i.test(marked)
      || /^(?:start|begin)\b/i.test(relation.fromText ?? "");
    const targetStartAction = /\b(?:start|begin)\s+TARGET/i.test(marked) || /^(?:start|begin)\b/i.test(relation.toText ?? "");
    const finishAction = /\b(?:finish\w*|complet\w*|submit\w*|send\w*|order|purchase)\b/i.test(from.title);
    if (minutes > 0 && !between && !startAction && !targetStartAction && !finishAction) continue;
    const exact = minutes > 0 && (startAction || targetStartAction) && !/\b(?:at least|by|no later|within)\b/i.test(source);
    results.push({ ...base, fromBoundary: direction === "before" && !startAction ? "end" : "start", toBoundary: direction === "before" ? "start" : "end", mode: exact ? "exact" : direction === "before" ? "latest" : "earliest", minutes, approximate: Boolean(offset && /\b(?:about|around|roughly)\b/i.test(marked.slice(Math.max(0, offset.index - 25), offset.index))) });
  }
  // Disagreement between valid parses is ambiguity, not an opportunity to
  // select whichever interpretation happens to agree with the model.
  const unique = new Map(results.map((result) => [JSON.stringify(result), result]));
  return unique.size === 1 ? [...unique.values()][0] : undefined;
}

export function verifyTemporalRelation(
  input: ExtractionInput, relation: Relation, from: Responsibility, to: Responsibility,
): VerifiedTiming | undefined {
  // Legacy grammar retained for comparison tests, not a production acceptance
  // gate. The compiler uses checkQuotedTiming and requires user confirmation.
  if (from.id === to.id || from.recurrence || to.recurrence) return undefined;
  const quoted = relation.sourceText ? exactSpan(input, relation.sourceText) : undefined;
  if (relation.sourceText && !quoted) return undefined;
  const fromSpan = exactSpan(input, from.sourceText);
  const toSpan = exactSpan(input, to.sourceText);
  const spans = [quoted, fromSpan, toSpan].filter((span): span is SourceEvidenceSpan => Boolean(span));
  const contextStart = Math.min(...spans.map((span) => span.start));
  const contextEnd = Math.max(...spans.map((span) => span.end));
  const context = Number.isFinite(contextStart) && contextEnd - contextStart <= 700
    ? input.text.slice(contextStart, contextEnd) : undefined;
  const quotes = relation.sourceText ? [relation.sourceText, ...(context ? [context] : [])] : [...new Set([
    from.sourceText, to.sourceText,
    ...(input.text.length <= 700 ? [input.text] : []),
    ...input.text.split(/(?<=[.!?])\s+|\r?\n/).filter((text) => text.length <= 700),
  ])];
  for (const quote of quotes) {
    const evidence = exactSpan(input, quote);
    if (!evidence) continue;
    let parsed = verifiedCandidate(relation, quote, from, to);
    // Retain the existing narrow calendar-day shipping rule. Business days,
    // uncertain delivery promises, and unrelated products are not supported.
    const shipping = new RegExp(`\\b(?:shipping|delivery|processing|transit)\\s+takes?\\s+(${NUMBER})\\s*[-–—]\\s*(${NUMBER})\\s*(days?|weeks?)\\b`, "i").exec(quote);
    const commonSubject = words(from.title).some((word) => words(to.title).includes(word) && !["arrive", "finish", "order"].includes(word));
    if (!parsed && shipping && relation.relation === "before" && to.kind === "milestone"
      && /\b(?:order|purchase|request)\b/i.test(from.title) && commonSubject
      && quote.includes(from.sourceText) && quote.includes(to.sourceText)
      && !/\b(?:business|working|maybe|probably|might)\b/i.test(quote)) {
      parsed = { fromBoundary: "end", toBoundary: "start", mode: "latest", minutes: quantity(shipping[2], shipping[3]), approximate: false, arrival: false, travel: false };
    }
    if (!parsed) continue;
    if (parsed.minutes === 0 && (relation.minimumGapMinutes ?? 0) > 0) return undefined;
    const softWording = /\b(?:if possible|prefer\w*|ideally|try to)\b/i.test(quote);
    const verifiedRelation = { ...relation, strength: softWording ? "soft" as const : relation.strength, minimumGapMinutes: parsed.minutes };
    // Maximum delays require their own grammar. Until supported, an AI-only
    // maximum must not quietly become a hard scheduling constraint.
    if (relation.maximumLagMinutes !== undefined && !(parsed.mode === "exact" && relation.maximumLagMinutes === parsed.minutes)) return undefined;
    return { ...parsed, relation: verifiedRelation, evidence };
  }
  return undefined;
}

export function clockEvidenceForRelativeTask(source: string, item: Responsibility, links: VerifiedTiming[]): string[] {
  const hints = links.filter((link) => link.relation.fromId === item.id).map((link) => link.relation.fromText).filter((hint): hint is string => Boolean(hint));
  const identity = new Set(words(item.title));
  return source.split(/(?<=[.!?])\s+|,\s*(?:but|and)\s+/).filter((clause) =>
    hints.length ? hints.some((hint) => clause.includes(hint)) : words(clause).some((word) => identity.has(word)),
  );
}

export function verifiedWorkDuration(item: Responsibility, input: ExtractionInput): { minutes: number; approximate: boolean } | undefined {
  if (!input.text.includes(item.sourceText) || !item.duration?.explicit) return undefined;
  const expected = item.duration.preferredMinutes ?? item.duration.minimumMinutes;
  if (!expected) return undefined;
  // Require an actual duration construction in the task's own evidence; an
  // arrival buffer or an unrelated number elsewhere is not active work.
  const durationPattern = new RegExp(`(?:\\b(?:takes?|lasts?|requires?|for|spend|allow)\\s+(?:about\\s+|around\\s+|roughly\\s+|approximately\\s+)?|\\b(?:a|an)\\s+)?${QUANTITY}`, "gi");
  const candidates = [...item.sourceText.matchAll(durationPattern)].filter((match) => {
    if (!completeQuantity(item.sourceText, match)) return false;
    const tail = item.sourceText.slice(match.index! + match[0].length);
    const before = item.sourceText.slice(0, match.index);
    const previousSentence = before.lastIndexOf(". ");
    const sentenceStart = Math.max(previousSentence < 0 ? 0 : previousSentence + 2, before.lastIndexOf("\n") + 1);
    const sentenceEnd = item.sourceText.indexOf(". ", match.index);
    const sentence = item.sourceText.slice(sentenceStart, sentenceEnd < 0 ? undefined : sentenceEnd);
    const identity = new Set(words(item.title));
    const ownsDuration = words(sentence).some((word) => identity.has(word));
    return ownsDuration && !/^\s*(?:early|earlier|before|after|ahead)\b/i.test(tail);
  }).map((match) => ({ minutes: quantity(match[1], match[2]), approximate: /\b(?:about|around|roughly|approximately|usually|probably|maybe)\b/i.test(item.sourceText.slice(Math.max(0, match.index! - 30), match.index! + match[0].length)) }));
  // An ambiguous multi-task quotation cannot prove whose duration this is.
  const distinct = new Set(candidates.map((candidate) => candidate.minutes));
  return distinct.size === 1 ? candidates.find((candidate) => candidate.minutes === expected) : undefined;
}
