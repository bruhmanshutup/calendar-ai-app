import type { ExtractionInput, ExtractionResult } from "@/lib/domain/types";
import { isExplicitDayAgenda } from "./day-agenda";
import { parseStructuredLearningPlan } from "./structured-plan-recovery";

const COMPLEX_SCHEDULING_LANGUAGE =
  /\b(?:after that|before that|beforehand|once (?:that|this) is done|and then|but (?:i|we) also|so (?:i|we) need|depends? on|prerequisite|split (?:it|this|that)?\s*(?:into|across|over)|sessions? (?:across|over)|avoid consecutive|back-to-back|if possible|i(?:'|’)d rather|i (?:would )?prefer|only open|business hours|do not schedule|don(?:'|’)t schedule|keep .{0,30} free|wake up|go to sleep)\b/i;

const CRITICAL_REVIEW_ITEM =
  /\b(?:clarify|fixed (?:event )?(?:end|time)|exact (?:clock )?time|recurrence (?:start|phase)|calendar|holiday|shift|travel|school day)\b/i;

function actionCueCount(value: string): number {
  return (
    value.match(
      /\b(?:apply|approve|book|call|cancel|clean|complete|confirm|draft|email|finish|fix|pay|prepare|read|renew|reply|review|schedule|send|sign|study|submit|update|upload|write)\b/gi,
    )?.length ?? 0
  );
}

/**
 * Estimates whether a local fallback is straightforward enough to remain
 * immediately usable. This must never be used to bypass a configured semantic
 * provider; the hybrid pipeline always calls that provider first.
 */
export function isStraightforwardLocalExtraction(
  input: ExtractionInput,
  local: ExtractionResult,
): boolean {
  if (local.tasks.length === 0) return false;
  // These two formats carry their scheduling structure explicitly. Their
  // deterministic recovery is safer than blanket-reviewing every row merely
  // because a long AI request timed out.
  if (
    isExplicitDayAgenda(input.text) ||
    Boolean(parseStructuredLearningPlan(input.text))
  ) {
    return true;
  }
  if (input.text.length > 20_000) return false;
  if (COMPLEX_SCHEDULING_LANGUAGE.test(input.text)) return false;
  if (
    local.tasks.some((task) =>
      task.missingInformation.some((item) => CRITICAL_REVIEW_ITEM.test(item)),
    )
  ) {
    return false;
  }

  const paragraphs = input.text.split(/\r?\n\s*\r?\n/);
  if (
    paragraphs.some(
      (paragraph) => paragraph.length > 280 && actionCueCount(paragraph) > 1,
    )
  ) {
    return false;
  }

  return true;
}

/** @deprecated Use only as a backward-compatible alias in legacy tests/callers. */
export const shouldUseFastLocalExtraction = isStraightforwardLocalExtraction;
