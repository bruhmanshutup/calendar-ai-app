import type { ExtractedTask, ExtractionInput, SourceEvidenceSpan } from "@/lib/domain/types";
import { parseClockTime } from "@/lib/domain/date-interpretation";

/** Validate the AI's chosen clock against user evidence; never choose task scope or a clock. */
export function userDeadlineClockEvidence(input: ExtractionInput, task: ExtractedTask): SourceEvidenceSpan | undefined {
  const instructions = input.globalInstructions?.trim();
  if (!instructions || !task.dueTime || !/\b(?:deadline|deadlines|due)\b/i.test(instructions)) return;
  const clocks: string[] = [];
  for (const match of instructions.matchAll(/\b(\d{1,2}(?::\d{2})?)\s*(a\.?m\.?|p\.?m\.?|(?:in the )?morning|(?:in the )?afternoon|(?:in the )?evening)\b/gi)) {
    const meridiem = /^(?:a|.*morning)/i.test(match[2]) && !/afternoon/i.test(match[2]) ? "am" : "pm";
    const clock = parseClockTime(`${match[1]} ${meridiem}`);
    if (clock) clocks.push(clock);
  }
  for (const match of instructions.matchAll(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/g)) clocks.push(match[0]);
  if (/\bnoon\b/i.test(instructions)) clocks.push("12:00");
  if (!clocks.includes(task.dueTime)) return;
  return { sourceId: "user-import-instructions", start: 0, end: instructions.length, quote: instructions };
}

export function annotateImportEvidence(input: ExtractionInput, task: ExtractedTask): ExtractedTask {
  const evidence = userDeadlineClockEvidence(input, task);
  let result = evidence ? { ...task, fieldProvenance: [
    ...(task.fieldProvenance ?? []).filter(f => f.path !== "dueTime" && f.path !== "dueAt"),
    { path: "dueTime", origin: "user" as const, evidence: [evidence], rationale: "Deadline time supplied in your import instructions, not printed in the document." },
    ...(task.dueAt ? [{ path: "dueAt", origin: "derived" as const, evidence: [evidence], rationale: "Combined the interpreted date with your requested deadline time." }] : []),
  ] } : task;
  // A yearless numeric calendar is not a unique date. Keep its MM/DD visible
  // for review instead of allowing an AI-picked historical year into scheduling.
  const calendar = /\|[^\r\n]*\bDate\b[^\r\n]*\|/i.test(input.text);
  const hasYear = /\b(?:19|20|21)\d{2}\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2}\b/.test(`${input.text}\n${input.globalInstructions ?? ""}`);
  if (calendar && !hasYear && result.dueDate) {
    const [, month, day] = result.dueDate.split("-");
    const numericDate = new RegExp(`\\b0?${Number(month)}[/-]0?${Number(day)}\\b`);
    if (numericDate.test(input.text)) {
      const question = `Confirm the year for ${month}/${day}; the calendar provides only month/day. No year has been scheduled.`;
      result = { ...result, dueDate: undefined, dueAt: undefined, dueWindow: undefined,
        approved: false, reviewRequired: true,
        missingInformation: [...new Set([...result.missingInformation, question])].slice(-20),
        fieldProvenance: result.fieldProvenance?.filter(f => !["dueDate", "dueAt", "dueWindow"].includes(f.path)),
      };
    }
  }
  return result;
}
