import type {
  ExtractedTask,
  ExtractionInput,
  ExtractionResult,
} from "@/lib/domain/types";

export type OpenAIVerificationMode = "always" | "auto" | "off";

export type VerificationDecision = {
  shouldVerify: boolean;
  mode: OpenAIVerificationMode;
  riskScore: number;
  reasons: string[];
};

function hasLowConfidence(task: ExtractedTask): boolean {
  if (task.confidence < 0.84) return true;
  return Object.values(task.fieldConfidence).some(
    (value) => value !== undefined && value < 0.8,
  );
}

function hasHighRiskTask(task: ExtractedTask): boolean {
  return Boolean(
    task.reviewRequired ||
      task.missingInformation.length > 0 ||
      hasLowConfidence(task) ||
      task.dependencies?.length ||
      task.conditionalRules?.length ||
      task.recurrence ||
      task.dueWindow ||
      task.occurrenceWindow ||
      task.sequence ||
      task.schedulingConstraints,
  );
}

function sourceRisk(input: ExtractionInput): { points: number; reasons: string[] } {
  const text = input.text;
  const lower = text.toLowerCase();
  const reasons: string[] = [];
  let points = 0;

  if (/\b(moved|rescheduled|instead|ignore|cancel(?:led|ed)?|supersed|no longer)\b/i.test(text)) {
    points += 2;
    reasons.push("correction-or-cancellation-language");
  }
  if (/\b(if|unless|only if|when|provided that)\b/i.test(text)) {
    points += 2;
    reasons.push("conditional-language");
  }
  if (/\b(every|each|daily|weekly|monthly|weekdays|weekends)\b/i.test(text)) {
    points += 1;
    reasons.push("recurring-language");
  }
  if (/\b(after|before|prior to|once|until|between|by the time)\b/i.test(text)) {
    points += 1;
    reasons.push("relative-ordering-language");
  }
  if (/\b(approximately|about|around|sometime|probably|maybe|preferably|if possible|should)\b/i.test(text)) {
    points += 1;
    reasons.push("imprecise-or-preference-language");
  }
  const tableRows = text.split(/\r?\n/).filter((line) => line.includes("|")).length;
  if (tableRows >= 2) {
    points += 2;
    reasons.push("structured-table-input");
  }
  const dateAndTimeMentions = (lower.match(/\b(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{4}-\d{2}-\d{2}|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b)\b/gi) ?? []).length;
  if (dateAndTimeMentions >= 6) {
    points += 1;
    reasons.push("many-temporal-mentions");
  }
  if (text.length > 1800 || text.split(/\s+/).length > 260) {
    points += 1;
    reasons.push("long-source");
  }

  return { points, reasons };
}

export function decideOpenAIVerification(
  input: ExtractionInput,
  draft: ExtractionResult,
  configuredMode = process.env.OPENAI_EXTRACTION_VERIFY ?? "auto",
): VerificationDecision {
  const normalizedMode: OpenAIVerificationMode =
    configuredMode === "1" || configuredMode === "always"
      ? "always"
      : configuredMode === "0" || configuredMode === "off"
        ? "off"
        : "auto";

  if (normalizedMode === "off") {
    return {
      shouldVerify: false,
      mode: normalizedMode,
      riskScore: 0,
      reasons: ["verification-disabled"],
    };
  }
  if (normalizedMode === "always") {
    return {
      shouldVerify: true,
      mode: normalizedMode,
      riskScore: Number.POSITIVE_INFINITY,
      reasons: ["verification-always-on"],
    };
  }

  let riskScore = 0;
  const reasons: string[] = [];
  const highRiskTaskCount = draft.tasks.filter(hasHighRiskTask).length;
  if (highRiskTaskCount > 0) {
    riskScore += Math.min(4, highRiskTaskCount * 2);
    reasons.push(`${highRiskTaskCount}-high-risk-task${highRiskTaskCount === 1 ? "" : "s"}`);
  }
  if (draft.tasks.length >= 4) {
    riskScore += 1;
    reasons.push("multiple-responsibilities");
  }
  if (draft.planningRules?.blockedTimes?.length) {
    riskScore += 1;
    reasons.push("blocked-time-rules");
  }
  if (draft.ignoredStatements.length > 0) {
    riskScore += 1;
    reasons.push("ignored-source-statements");
  }

  const source = sourceRisk(input);
  riskScore += source.points;
  reasons.push(...source.reasons);

  const shouldVerify = riskScore >= 3;
  return {
    shouldVerify,
    mode: normalizedMode,
    riskScore,
    reasons: [
      ...(reasons.length ? reasons : ["low-risk-explicit-input"]),
      ...(shouldVerify ? [] : ["risk-below-threshold"]),
    ],
  };
}
