import { validateAndDedupeExtraction } from "@/lib/domain/extraction-schema";
import type {
  ExtractedTask,
  ExtractionInput,
  ExtractionResult,
} from "@/lib/domain/types";
import { MockTaskExtractionProvider } from "./mock-extraction";

function comparable(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLocaleLowerCase();
}

function canonicalTitle(value: string): string {
  return comparable(value).replace(
    /^(?:action required|reminder|please|kindly|can you|could you|would you|make sure to|remember to|don t forget to)\s+/,
    "",
  );
}

function temporalFieldsAgree(first: ExtractedTask, second: ExtractedTask): boolean {
  if (first.dueDate && second.dueDate && first.dueDate !== second.dueDate) {
    return false;
  }
  if (
    first.fixedStartAt &&
    second.fixedStartAt &&
    first.fixedStartAt !== second.fixedStartAt
  ) {
    return false;
  }
  return true;
}

function alreadyExtracted(
  tasks: ExtractedTask[],
  candidate: ExtractedTask,
): boolean {
  const source = comparable(candidate.sourceText);
  const title = canonicalTitle(candidate.title);
  return tasks.some((task) => {
    if (!temporalFieldsAgree(task, candidate)) return false;
    const existingSource = comparable(task.sourceText);
    if (source && existingSource === source) return true;
    const existingTitle = canonicalTitle(task.title);
    return (
      existingTitle === title ||
      (Math.min(existingTitle.length, title.length) >= 12 &&
        (existingTitle.includes(title) || title.includes(existingTitle)))
    );
  });
}

function isStrongRecoveryCandidate(task: ExtractedTask): boolean {
  const source = task.sourceText.trim();
  return Boolean(
    task.dueDate ||
      task.fixedStartAt ||
      task.recurrence ||
      /^\s*(?:[-*•▪‣→☐□⬜🔲]|\d+[.)]|[ivxlcdm]+[.)]|\[[ xX]\])/iu.test(
        source,
      ) ||
      /^\s*\|.*\|\s*$/.test(source) ||
      /^\s*(?:task|to-?do|action item|subject)\s*:/i.test(source) ||
      /\b(?:action required|approval required|response required|please|kindly|can you|could you|would you|remember to|don't forget to)\b/i.test(
        source,
      ) ||
      /^\[[^\]]+\]\s*[^:]{1,40}:\s*/u.test(source)
  );
}

export async function recoverConcreteFormattedTasks(
  input: ExtractionInput,
  result: ExtractionResult,
): Promise<ExtractionResult> {
  const local = await new MockTaskExtractionProvider().extractTasks(input);
  const remainingCapacity = Math.max(0, 100 - result.tasks.length);
  if (remainingCapacity === 0) return result;

  const recovered: ExtractedTask[] = [];
  for (const task of local.tasks) {
    if (
      recovered.length >= remainingCapacity ||
      !isStrongRecoveryCandidate(task) ||
      alreadyExtracted([...result.tasks, ...recovered], task)
    ) {
      continue;
    }
    recovered.push({
      ...task,
      id: `recovered-format-${recovered.length + 1}`,
    });
  }
  if (recovered.length === 0) return result;

  const recoveredSources = new Set(
    recovered.map((task) => comparable(task.sourceText)),
  );
  return validateAndDedupeExtraction({
    tasks: [...result.tasks, ...recovered],
    ignoredStatements: result.ignoredStatements.filter(
      (statement) => !recoveredSources.has(comparable(statement.sourceText)),
    ),
  });
}
