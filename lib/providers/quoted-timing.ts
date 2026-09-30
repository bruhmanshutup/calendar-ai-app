import type { ExtractionInput, SourceEvidenceSpan } from "@/lib/domain/types";
import type { SemanticDraft } from "./semantic-draft";

type Responsibility = SemanticDraft["responsibilities"][number];
type Relation = SemanticDraft["relations"][number];

export const RELATIONSHIP_REVIEW_MESSAGE = "Confirm the relationship and calculated timing. The quote is present; AI-interpreted meaning has not been independently verified.";

/** Structurally checked AI interpretation, NOT independently verified meaning. */
export type QuotedTiming = {
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

function sourceQuote(text: string, quote?: string): string | undefined {
  if (!quote?.trim()) return;
  if (text.includes(quote)) return quote;
  // An ellipsis is sometimes a model's abbreviation rather than a paraphrase.
  // Expand it only when every literal fragment has one unique, ordered match.
  const fragments = quote.split(/\.{3}|…/).map((part) => part.trim());
  if (fragments.length < 2 || fragments.some((part) => part.length < 4)) return;
  let start = -1, end = 0;
  for (const fragment of fragments) {
    const index = text.indexOf(fragment);
    if (index < end || text.indexOf(fragment, index + 1) >= 0) return;
    if (start < 0) start = index;
    end = index + fragment.length;
  }
  return start >= 0 ? text.slice(start, end) : undefined;
}

export function checkQuotedTiming(
  input: ExtractionInput,
  relation: Relation,
  from: Responsibility,
  to: Responsibility,
): QuotedTiming | undefined {
  if (from.id === to.id || relation.fromId !== from.id || relation.toId !== to.id) return;
  // Occurrence-specific recurrence relationships need an occurrence identity.
  if (from.recurrence || to.recurrence) return;
  const quote = sourceQuote(input.text, relation.sourceText);
  if (!quote?.trim() || !from.sourceText.trim() || !to.sourceText.trim()) return;
  const start = input.text.indexOf(quote);
  if (start < 0 || !input.text.includes(from.sourceText) || !input.text.includes(to.sourceText)) return;
  const minutes = relation.minimumGapMinutes ?? 0;
  const maximum = relation.maximumLagMinutes;
  if (!["before", "after"].includes(relation.relation) || !["hard", "soft"].includes(relation.strength)) return;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 60 * 24 * 60) return;
  if (maximum !== undefined && (!Number.isInteger(maximum) || maximum < minutes || maximum > 60 * 24 * 60)) return;
  const arrival = relation.timing === "arrival_buffer";
  const travel = relation.timing === "travel";
  // Defaults are conventions of the structured contract, not language guesses.
  const fromBoundary = relation.fromBoundary ?? (arrival || relation.timing === "offset" ? "start" : relation.relation === "before" ? "end" : "start");
  const toBoundary = relation.toBoundary ?? (relation.relation === "before" ? "start" : "end");
  const mode = relation.mode ?? (arrival || travel || relation.timing === "offset" ? "exact" : relation.relation === "before" ? "latest" : "earliest");
  if (!["start", "end"].includes(fromBoundary) || !["start", "end"].includes(toBoundary) || !["exact", "latest", "earliest"].includes(mode)) return;
  if (arrival && (relation.relation !== "before" || fromBoundary !== "start" || toBoundary !== "start")) return;
  if (travel && (relation.relation !== "before" || fromBoundary !== "end" || toBoundary !== "start" || minutes !== 0)) return;
  if (maximum !== undefined && mode === "exact" && maximum !== minutes) return;
  return {
    relation, fromBoundary, toBoundary, mode, minutes, arrival, travel,
    approximate: relation.approximate ?? false,
    evidence: { ...(input.sourceId ? { sourceId: input.sourceId } : {}), start, end: start + quote.length, quote },
  };
}

/** Use the AI's numeric duration, with its source present, for review-only arithmetic. */
export function interpretedWorkDuration(item: Responsibility, input: ExtractionInput, planningEstimate?: number) {
  if (item.kind === "milestone" || !input.text.includes(item.sourceText)) return;
  const minutes = item.duration?.preferredMinutes ?? item.duration?.maximumMinutes
    ?? item.duration?.minimumMinutes ?? item.planning?.estimatedMinutes ?? planningEstimate;
  if (!minutes || !Number.isInteger(minutes) || minutes > 1440) return;
  return {
    minutes,
    approximate: item.duration?.explicit !== true || item.duration.approximate === true,
  };
}
